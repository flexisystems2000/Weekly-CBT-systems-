require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");

const admin = require("firebase-admin");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const DASHBOARD_PASSWORD = "admin";

const QUESTION_BANK_BASE_URL =
  "https://raw.githubusercontent.com/flexisystems2000/Weekly-CBT-Mock-/main/questions";

const AUTH_FOLDER = "./auth_info_baileys";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// ============================================================
// FIREBASE
// ============================================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is missing.");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  console.error(error.message);
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch (error) {
  console.error("❌ Firebase initialization failed:");
  console.error(error);
  process.exit(1);
}

const db = admin.firestore();

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

// ============================================================
// GLOBAL STATE
// ============================================================

let sock = null;

let connectionState = "closed";

let startingWhatsApp = false;

let reconnectTimer = null;

let pairingInProgress = false;

let pairingNumber = null;

let latestPairingCode = null;

let lastConnectionError = null;

let connectedNumber = null;

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhoneNumber(number) {
  if (!number) return null;

  let value = String(number).replace(/\D/g, "");

  if (value.startsWith("234")) {
    return value;
  }

  if (value.startsWith("0")) {
    return "234" + value.substring(1);
  }

  return value;
}

function formatPhoneNumber(number) {
  const normalized = normalizePhoneNumber(number);

  if (!normalized) return "";

  if (normalized.startsWith("234") && normalized.length === 13) {
    return "0" + normalized.substring(3);
  }

  return normalized;
}

function jidToPhone(jid) {
  if (!jid) return null;

  const value = String(jid).split(":")[0].split("@")[0];

  return normalizePhoneNumber(value);
}

function generateRegistrationNumber() {
  const number = Math.floor(
    10000000000 + Math.random() * 90000000000
  );

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const first =
    letters[Math.floor(Math.random() * letters.length)];

  const second =
    letters[Math.floor(Math.random() * letters.length)];

  return `${number}${first}${second}`;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ============================================================
// MESSAGE TEXT EXTRACTION
// ============================================================

function extractMessageText(message) {
  if (!message) return "";

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  return "";
}

// ============================================================
// QUESTION BANK
// ============================================================

const SUBJECT_FILES = {
  Mathematics: "01_Mathematics_Module_1-3.json",

  Physics: "02_Physics_Module_1-3.json",

  Chemistry: "03_Chemistry_Module_1-3.json",

  Biology: "04_Biology_Module_1-3.json",

  Commerce: "05_Commerce_Module_1-3.json",

  "Financial Accounting":
    "06_Financial_Accounting_Module_1-3.json",

  "Literature in English":
    "07_Literature_in_English_Module_1-3.json",

  Government: "08_Government_Module_1-3.json",

  "Christian Religious Knowledge":
    "09_Crk_Module_1-3.json",

  Economics: "10_Economics_Module_1-3.json",

  "Civic Education":
    "11_Civic_Education_Module_1-3.json",

  "Use of English":
    "12_Use_of_English_and_The_Lekki_Headmaster_Module_1-3.json",
};

async function fetchQuestionBank(subject) {
  const filename = SUBJECT_FILES[subject];

  if (!filename) {
    throw new Error(`No question bank found for ${subject}`);
  }

  const url =
    `${QUESTION_BANK_BASE_URL}/${encodeURIComponent(filename)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${subject} question bank: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  return data;
}

// ============================================================
// QUESTION NORMALIZATION
// ============================================================

function getQuestionArray(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.questions)) {
    return data.questions;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.items)) {
    return data.items;
  }

  return [];
}

function getCorrectAnswer(question) {
  if (!question) return "";

  const answer =
    question.answer ??
    question.correctAnswer ??
    question.correct_answer ??
    question.correct ??
    question.key;

  if (typeof answer === "string") {
    return answer.trim().toUpperCase().charAt(0);
  }

  return "";
}

function getQuestionId(question, index) {
  if (!question) return String(index + 1);

  return String(
    question.id ??
      question.questionId ??
      question.number ??
      index + 1
  );
}

// ============================================================
// RESULT LOOKUP
// ============================================================

async function findCandidateResult(phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);

  if (!normalized) {
    return null;
  }

  const possibleNumbers = new Set();

  possibleNumbers.add(normalized);

  possibleNumbers.add("+" + normalized);

  if (normalized.startsWith("234")) {
    possibleNumbers.add("0" + normalized.substring(3));
  }

  for (const value of possibleNumbers) {
    const snapshot = await db
      .collection("cbt_submissions")
      .where("candidate.whatsapp", "==", value)
      .limit(10)
      .get();

    if (!snapshot.empty) {
      return snapshot.docs[0];
    }
  }

  const snapshot2 = await db
    .collection("cbt_submissions")
    .where("candidateWhatsApp", "==", normalized)
    .limit(10)
    .get();

  if (!snapshot2.empty) {
    return snapshot2.docs[0];
  }

  return null;
}

// ============================================================
// REGISTRATION NUMBER
// ============================================================

async function ensureRegistrationNumber(doc) {
  const data = doc.data() || {};

  let registrationNumber =
    data.registrationNumber ||
    data.candidate?.registrationNumber ||
    data.regNo ||
    data.regNumber;

  if (registrationNumber) {
    return registrationNumber;
  }

  registrationNumber = generateRegistrationNumber();

  await doc.ref.update({
    registrationNumber,
  });

  return registrationNumber;
}

// ============================================================
// SCORING
// ============================================================

async function calculateSubjectScore(subject, answers) {
  const bank = await fetchQuestionBank(subject);

  const questions = getQuestionArray(bank).slice(0, 15);

  let rawScore = 0;

  const candidateAnswers =
    answers?.[subject] ||
    answers?.[subject.toLowerCase()] ||
    {};

  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];

    const questionId = getQuestionId(question, index);

    let candidateAnswer =
      candidateAnswers[questionId];

    if (
      candidateAnswer === undefined &&
      Array.isArray(candidateAnswers)
    ) {
      candidateAnswer = candidateAnswers[index];
    }

    if (
      candidateAnswer === undefined &&
      candidateAnswers[String(index + 1)] !== undefined
    ) {
      candidateAnswer =
        candidateAnswers[String(index + 1)];
    }

    const correctAnswer =
      getCorrectAnswer(question);

    if (!candidateAnswer) {
      continue;
    }

    const normalizedCandidate =
      String(candidateAnswer)
        .trim()
        .toUpperCase()
        .charAt(0);

    if (
      normalizedCandidate &&
      normalizedCandidate === correctAnswer
    ) {
      rawScore++;
    }
  }

  const score =
    questions.length > 0
      ? Math.round((rawScore / questions.length) * 100)
      : 0;

  return {
    rawScore,
    totalQuestions: questions.length,
    score,
  };
}

// ============================================================
// EXTRACT ANSWERS
// ============================================================

function extractAnswers(data) {
  return (
    data.answers ||
    data.candidate?.answers ||
    data.responses ||
    {}
  );
}

// ============================================================
// RESULT FORMATTER
// ============================================================

async function buildResultMessage(doc) {
  const data = doc.data() || {};

  const candidate =
    data.candidate || {};

  const name =
    candidate.name ||
    data.candidateName ||
    data.name ||
    "Candidate";

  const whatsapp =
    candidate.whatsapp ||
    data.candidateWhatsApp ||
    data.whatsapp ||
    "";

  const registrationNumber =
    await ensureRegistrationNumber(doc);

  const subjects =
    candidate.subjects ||
    data.subjects ||
    [];

  const answers = extractAnswers(data);

  let resultLines = [];

  let aggregate = 0;

  let totalSubjects = 0;

  for (const subject of subjects) {
    if (!SUBJECT_FILES[subject]) {
      continue;
    }

    try {
      const result =
        await calculateSubjectScore(
          subject,
          answers
        );

      resultLines.push(
        `📘 ${subject}: ${result.score}/100`
      );

      aggregate += result.score;

      totalSubjects++;
    } catch (error) {
      console.error(
        `Error scoring ${subject}:`,
        error.message
      );

      resultLines.push(
        `📘 ${subject}: Unable to calculate`
      );
    }
  }

  let average = 0;

  if (totalSubjects > 0) {
    average = Math.round(
      aggregate / totalSubjects
    );
  }

  const savedAggregate =
    data.aggregateScore ??
    data.totalScore ??
    data.score;

  if (
    resultLines.length === 0 &&
    savedAggregate !== undefined
  ) {
    average = Number(savedAggregate) || 0;
  }

  return `
╭━━━━━━━━━━━━━━━━━━━━╮
      📊 *MOCK CBT RESULT*
╰━━━━━━━━━━━━━━━━━━━━╯

👤 *Candidate:* ${name}

🆔 *Registration No:* ${registrationNumber}

📱 *WhatsApp:* ${formatPhoneNumber(whatsapp)}

━━━━━━━━━━━━━━━━━━━━

${resultLines.join("\n")}

━━━━━━━━━━━━━━━━━━━━

🏆 *Overall Score:* ${average}/100

📚 *Subjects:* ${totalSubjects}

━━━━━━━━━━━━━━━━━━━━

✅ Result successfully retrieved.

_Flexi Educational Consult_
`;
}

// ============================================================
// WHATSAPP SOCKET
// ============================================================

async function createWhatsAppSocket() {
  fs.mkdirSync(AUTH_FOLDER, {
    recursive: true,
  });

  const {
    state,
    saveCreds,
  } = await useMultiFileAuthState(
    AUTH_FOLDER
  );

  let version;

  try {
    const latest =
      await fetchLatestBaileysVersion();

    version = latest.version;

    console.log(
      `Using Baileys version: ${version.join(".")}`
    );
  } catch (error) {
    console.log(
      "Could not fetch latest Baileys version. Using library default."
    );
  }

  const socketOptions = {
    ...(version ? { version } : {}),

    auth: {
      creds: state.creds,

      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger
      ),
    },

    logger,

    browser:
      Browsers.appropriate("Chrome"),

    markOnlineOnConnect: false,

    syncFullHistory: false,

    generateHighQualityLinkPreview: false,

    keepAliveIntervalMs: 30000,

    connectTimeoutMs: 60000,
  };

  const newSock =
    makeWASocket(socketOptions);

  newSock.ev.on(
    "creds.update",
    saveCreds
  );

  return newSock;
}

// ============================================================
// START WHATSAPP
// ============================================================

async function startWhatsApp() {
  if (startingWhatsApp) {
    return;
  }

  if (
    sock &&
    connectionState === "open"
  ) {
    return;
  }

  startingWhatsApp = true;

  try {
    console.log(
      "Starting WhatsApp connection..."
    );

    connectionState = "connecting";

    const newSock =
      await createWhatsAppSocket();

    sock = newSock;

    // --------------------------------------------------------
    // CONNECTION UPDATE
    // --------------------------------------------------------

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
        } = update;

        if (connection === "open") {
          connectionState = "open";

          startingWhatsApp = false;

          pairingInProgress = false;

          pairingNumber = null;

          latestPairingCode = null;

          lastConnectionError = null;

          connectedNumber =
            jidToPhone(sock?.user?.id);

          console.log(
            "✅ WhatsApp connected successfully."
          );

          console.log(
            "Connected number:",
            connectedNumber
              ? formatPhoneNumber(
                  connectedNumber
                )
              : "Unknown"
          );

          return;
        }

        if (connection === "connecting") {
          connectionState = "connecting";

          console.log(
            "🔄 WhatsApp connecting..."
          );

          return;
        }

        if (connection === "close") {
          connectionState = "closed";

          startingWhatsApp = false;

          connectedNumber = null;

          let statusCode = null;

          try {
            statusCode =
              lastDisconnect
                ?.error
                ?.output
                ?.statusCode;
          } catch {}

          const loggedOut =
            statusCode ===
            DisconnectReason.loggedOut;

          lastConnectionError =
            lastDisconnect?.error
              ? String(
                  lastDisconnect.error
                )
              : "Connection closed";

          console.log(
            "❌ WhatsApp connection closed."
          );

          console.log(
            "Status code:",
            statusCode
          );

          console.log(
            "Logged out:",
            loggedOut
          );

          if (loggedOut) {
            console.log(
              "⚠️ WhatsApp logged out. Auth was NOT automatically deleted."
            );

            pairingInProgress = false;

            pairingNumber = null;

            latestPairingCode = null;

            return;
          }

          if (reconnectTimer) {
            return;
          }

          reconnectTimer =
            setTimeout(async () => {
              reconnectTimer = null;

              try {
                await startWhatsApp();
              } catch (error) {
                console.error(
                  "Reconnect failed:",
                  error
                );
              }
            }, 5000);
        }
      }
    );

    // --------------------------------------------------------
    // MESSAGE HANDLER
    // --------------------------------------------------------

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {
        try {
          for (const message of messages) {
            await handleIncomingMessage(
              message
            );
          }
        } catch (error) {
          console.error(
            "Message handler error:",
            error
          );
        }
      }
    );
  } catch (error) {
    startingWhatsApp = false;

    connectionState = "closed";

    lastConnectionError =
      error?.message ||
      String(error);

    console.error(
      "❌ Failed to start WhatsApp:",
      error
    );
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleIncomingMessage(
  message
) {
  if (!message) {
    return;
  }

  if (message.key?.fromMe) {
    return;
  }

  const remoteJid =
    message.key?.remoteJid;

  if (!remoteJid) {
    return;
  }

  // Ignore groups
  if (remoteJid.endsWith("@g.us")) {
    return;
  }

  // Ignore status
  if (
    remoteJid ===
    "status@broadcast"
  ) {
    return;
  }

  const text =
    extractMessageText(
      message.message
    ).trim();

  if (!text) {
    return;
  }

  console.log(
    `📩 Message from ${remoteJid}: ${text}`
  );

  // ----------------------------------------------------------
  // RESULT COMMAND
  // ----------------------------------------------------------

  const resultMatch =
    text.match(
      /^MOCKRESULT\s*([0-9+ ]{10,20})$/i
    );

  if (!resultMatch) {
    return;
  }

  const requestedNumber =
    normalizePhoneNumber(
      resultMatch[1]
    );

  if (!requestedNumber) {
    await sendText(
      remoteJid,
      "❌ Please enter a valid Nigerian WhatsApp number."
    );

    return;
  }

  try {
    await sendText(
      remoteJid,
      `🔎 Searching for your mock CBT result...\n\n📱 Number: ${formatPhoneNumber(
        requestedNumber
      )}`
    );

    const doc =
      await findCandidateResult(
        requestedNumber
      );

    if (!doc) {
      await sendText(
        remoteJid,
        `
❌ *RESULT NOT FOUND*

We could not find a mock CBT result associated with:

📱 ${formatPhoneNumber(
          requestedNumber
        )}

Please make sure you entered the same WhatsApp number you used during registration.
`
      );

      return;
    }

    const resultMessage =
      await buildResultMessage(doc);

    await sendText(
      remoteJid,
      resultMessage
    );
  } catch (error) {
    console.error(
      "Result lookup error:",
      error
    );

    await sendText(
      remoteJid,
      `
❌ Sorry, an error occurred while retrieving your result.

Please try again shortly.
`
    );
  }
}

// ============================================================
// SEND MESSAGE
// ============================================================

async function sendText(
  jid,
  text
) {
  if (!sock) {
    throw new Error(
      "WhatsApp socket is not available."
    );
  }

  return sock.sendMessage(
    jid,
    {
      text,
    }
  );
}

// ============================================================
// DASHBOARD AUTH
// ============================================================

function checkDashboardPassword(req, res) {
  const password =
    req.headers["x-dashboard-password"] ||
    req.body?.password ||
    req.query?.password;

  if (
    password !==
    DASHBOARD_PASSWORD
  ) {
    res.status(401).json({
      success: false,
      error: "Invalid password",
    });

    return false;
  }

  return true;
}

// ============================================================
// DASHBOARD
// ============================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>Flexi MockResult Bot</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #07130e;
  color: white;
}

.container {
  max-width: 650px;
  margin: auto;
  padding: 20px;
}

.card {
  background: #0d2118;
  border: 1px solid #19452f;
  border-radius: 18px;
  padding: 22px;
  margin-bottom: 20px;
}

h1 {
  margin-top: 0;
  color: #5cff9a;
}

h2 {
  color: #8affb5;
}

input {
  width: 100%;
  padding: 14px;
  margin: 8px 0;
  border-radius: 10px;
  border: 1px solid #286b49;
  background: #07130e;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  padding: 14px;
  margin-top: 10px;
  border: none;
  border-radius: 10px;
  background: #1ca55b;
  color: white;
  font-size: 16px;
  font-weight: bold;
}

button:active {
  transform: scale(.98);
}

.status {
  padding: 14px;
  border-radius: 10px;
  background: #07130e;
  margin-top: 10px;
}

.code {
  font-size: 28px;
  letter-spacing: 5px;
  text-align: center;
  padding: 20px;
  background: #061b11;
  border-radius: 12px;
  color: #5cff9a;
  font-weight: bold;
  margin-top: 15px;
}

.small {
  opacity: .7;
  font-size: 13px;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
}

</style>
</head>

<body>

<div class="container">

<div class="card">

<h1>Flexi MockResult Bot</h1>

<p>
WhatsApp Mock CBT Result Bot
</p>

<div class="status">

<strong>Status:</strong>

<span id="status">
Checking...
</span>

</div>

</div>


<div class="card">

<h2>Dashboard Login</h2>

<input
  id="password"
  type="password"
  placeholder="Dashboard password"
/>

</div>


<div class="card">

<h2>Pair WhatsApp</h2>

<input
  id="phone"
  placeholder="08012345678"
  inputmode="numeric"
/>

<button onclick="pairWhatsApp()">
Generate Pairing Code
</button>

<div
  id="pairingCode"
  class="code"
  style="display:none"
></div>

<p class="small">
Enter the Nigerian WhatsApp number you want to connect,
then enter the generated pairing code inside WhatsApp.
</p>

</div>


<div class="card">

<h2>Result Command</h2>

<pre>
MOCKRESULT08012345678

or

MOCKRESULT 08012345678
</pre>

<p class="small">
Candidates should send the command to the bot in a private chat.
</p>

</div>

</div>


<script>

async function getPassword() {
  return document.getElementById(
    "password"
  ).value;
}


async function updateStatus() {

  try {

    const password =
      await getPassword();

    const response =
      await fetch(
        "/api/status?password=" +
        encodeURIComponent(password)
      );

    const data =
      await response.json();

    const status =
      document.getElementById(
        "status"
      );

    if (!data.success) {
      status.innerText =
        "Enter dashboard password";

      return;
    }

    status.innerText =
      data.connectionState +
      (
        data.connectedNumber
          ? " — " +
            data.connectedNumber
          : ""
      );

  } catch (error) {

    document.getElementById(
      "status"
    ).innerText =
      "Server error";
  }
}


async function pairWhatsApp() {

  const password =
    await getPassword();

  const phone =
    document.getElementById(
      "phone"
    ).value.trim();

  if (!password) {
    alert(
      "Enter dashboard password."
    );

    return;
  }

  if (!phone) {
    alert(
      "Enter WhatsApp number."
    );

    return;
  }

  const response =
    await fetch(
      "/api/pair",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          password,
          phone
        })
      }
    );

  const data =
    await response.json();

  if (!data.success) {

    alert(
      data.error ||
      "Pairing failed."
    );

    return;
  }

  const codeElement =
    document.getElementById(
      "pairingCode"
    );

  codeElement.style.display =
    "block";

  codeElement.innerText =
    data.code ||
    "Waiting...";

  updateStatus();
}


setInterval(
  updateStatus,
  5000
);

updateStatus();

</script>

</body>
</html>
`);
});

// ============================================================
// STATUS API
// ============================================================

app.get(
  "/api/status",
  (req, res) => {
    if (!checkDashboardPassword(req, res)) {
      return;
    }

    res.json({
      success: true,

      connectionState,

      connected:
        connectionState === "open",

      connectedNumber:
        connectedNumber
          ? formatPhoneNumber(
              connectedNumber
            )
          : null,

      pairingInProgress,

      pairingNumber:
        pairingNumber
          ? formatPhoneNumber(
              pairingNumber
            )
          : null,

      pairingCode:
        latestPairingCode,

      lastConnectionError,
    });
  }
);

// ============================================================
// PAIRING API
// ============================================================

app.post(
  "/api/pair",
  async (req, res) => {
    try {
      const password =
        req.body?.password;

      if (
        password !==
        DASHBOARD_PASSWORD
      ) {
        return res.status(401).json({
          success: false,
          error: "Invalid password.",
        });
      }

      const phone =
        normalizePhoneNumber(
          req.body?.phone
        );

      if (!phone) {
        return res.status(400).json({
          success: false,
          error:
            "Enter a valid WhatsApp number.",
        });
      }

      if (phone.length < 10) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid WhatsApp number.",
        });
      }

      // ------------------------------------------------------
      // ALREADY CONNECTED
      // ------------------------------------------------------

      if (
        sock &&
        connectionState === "open"
      ) {
        if (
          connectedNumber === phone
        ) {
          return res.json({
            success: true,
            alreadyConnected: true,
            message:
              "This WhatsApp number is already connected.",
          });
        }

        return res.status(409).json({
          success: false,
          error:
            "Another WhatsApp number is already connected. Log out that session before pairing a different number.",
        });
      }

      // ------------------------------------------------------
      // PREVENT DUPLICATE PAIRING
      // ------------------------------------------------------

      if (
        pairingInProgress &&
        pairingNumber === phone
      ) {
        return res.json({
          success: true,
          code:
            latestPairingCode,
          message:
            "Pairing is already in progress.",
        });
      }

      pairingInProgress = true;

      pairingNumber = phone;

      latestPairingCode = null;

      // ------------------------------------------------------
      // START SOCKET IF NEEDED
      // ------------------------------------------------------

      if (
        !sock ||
        connectionState === "closed"
      ) {
        await startWhatsApp();
      }

      // ------------------------------------------------------
      // WAIT FOR SOCKET
      // ------------------------------------------------------

      const start =
        Date.now();

      let pairingCode = null;

      while (
        Date.now() - start <
        30000
      ) {
        if (!sock) {
          await sleep(500);

          continue;
        }

        try {
          if (
            typeof sock.requestPairingCode ===
            "function"
          ) {
            pairingCode =
              await sock.requestPairingCode(
                phone
              );

            if (pairingCode) {
              break;
            }
          }
        } catch (error) {
          lastConnectionError =
            error?.message ||
            String(error);

          console.log(
            "Pairing code request waiting:",
            error?.message
          );
        }

        await sleep(1000);
      }

      if (!pairingCode) {
        pairingInProgress = false;

        pairingNumber = null;

        return res.status(500).json({
          success: false,

          error:
            "Could not generate pairing code within 30 seconds. Check the server logs and try again.",
        });
      }

      latestPairingCode =
        pairingCode;

      return res.json({
        success: true,

        code: pairingCode,

        phone:
          formatPhoneNumber(
            phone
          ),

        message:
          "Pairing code generated successfully.",
      });
    } catch (error) {
      console.error(
        "Pairing API error:",
        error
      );

      pairingInProgress = false;

      pairingNumber = null;

      latestPairingCode = null;

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Pairing failed.",
      });
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      whatsapp:
        connectionState,

      connected:
        connectionState === "open",

      uptime:
        process.uptime(),

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Not found",
    });
  }
);

// ============================================================
// SERVER START
// ============================================================

const server =
  app.listen(
    PORT,
    () => {
      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "      FLEXI MOCKRESULT BOT"
      );
      console.log(
        "========================================"
      );
      console.log(
        `Dashboard: http://localhost:${PORT}`
      );
      console.log(
        `Health:    http://localhost:${PORT}/health`
      );
      console.log(
        "WhatsApp:  Starting..."
      );
      console.log(
        "========================================"
      );
      console.log("");
    }
  );

// ============================================================
// START WHATSAPP AFTER SERVER
// ============================================================

startWhatsApp().catch(
  (error) => {
    console.error(
      "Initial WhatsApp startup error:",
      error
    );
  }
);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `\nReceived ${signal}. Shutting down...`
  );

  try {
    if (reconnectTimer) {
      clearTimeout(
        reconnectTimer
      );

      reconnectTimer = null;
    }

    if (sock) {
      try {
        sock.end(
          new Error(
            "Server shutting down"
          )
        );
      } catch {}
    }

    server.close(
      () => {
        console.log(
          "HTTP server closed."
        );

        process.exit(0);
      }
    );

    setTimeout(() => {
      process.exit(0);
    }, 5000);
  } catch (error) {
    console.error(
      "Shutdown error:",
      error
    );

    process.exit(1);
  }
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);
