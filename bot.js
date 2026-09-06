require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldPath, Timestamp } = require("firebase-admin/firestore");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const DASHBOARD_PASSWORD = "admin";

const QUESTION_BANK_BASE_URL =
    "https://raw.githubusercontent.com/flexisystems2000/Weekly-CBT-Mock-/main/questions";

const AUTH_FOLDER =
    process.env.AUTH_FOLDER || "./auth_info_baileys";

const LOG_LEVEL = "info";

const logger = pino({ level: LOG_LEVEL });

/* =========================================================
   FIREBASE
========================================================= */

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("ERROR: FIREBASE_SERVICE_ACCOUNT is missing from .env");
    process.exit(1);
}

let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
    console.error("ERROR: FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
    console.error(error.message);
    process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

/* =========================================================
   QUESTION BANK MAP
========================================================= */

const subjectFileMap = {
    "Mathematics": "01_Mathematics_Module_1-3.json",
    "Physics": "02_Physics_Module_1-3.json",
    "Chemistry": "03_Chemistry_Module_1-3.json",
    "Biology": "04_Biology_Module_1-3.json",
    "Commerce": "05_Commerce_Module_1-3.json",
    "Financial Accounting": "06_Financial_Accounting_Module_1-3.json",
    "Literature in English": "07_Literature_in_English_Module_1-3.json",
    "Government": "08_Government_Module_1-3.json",
    "Christian Religious Knowledge": "09_Crk_Module_1-3.json",
    "Economics": "10_Economics_Module_1-3.json",
    "Civic Education": "11_Civic_Education_Module_1-3.json",
    "Use of English": "12_Use_of_English_and_The_Lekki_Headmaster_Module_1-3.json"
};

/* =========================================================
   GLOBAL STATE
========================================================= */

let sock = null;
let connectionState = "disconnected";
let pairingInProgress = false;
let currentPairingNumber = "";
let pairingCode = "";
let lastConnectionUpdate = null;
let reconnectTimer = null;
let botStarting = false;

/* =========================================================
   EXPRESS
========================================================= */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   DASHBOARD AUTH
========================================================= */

function dashboardAuth(req, res, next) {
    const password = req.headers["x-dashboard-password"] ||
                     req.query.password ||
                     req.body?.password;

    if (password !== DASHBOARD_PASSWORD) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
}

/* =========================================================
   PHONE NUMBER HELPERS
========================================================= */

function normalizePhoneNumber(number) {
    if (!number) return "";
    let phone = String(number).trim().replace(/[^\d+]/g, "");
    if (phone.startsWith("+")) phone = phone.substring(1);
    if (phone.startsWith("0") && phone.length === 11) {
        phone = "234" + phone.substring(1);
    }
    return phone;
}

function isValidWhatsAppNumber(number) {
    return /^\d{10,15}$/.test(number);
}

function jidToPhone(jid) {
    if (!jid) return "";
    return String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/* =========================================================
   REGISTRATION NUMBER
========================================================= */

function generateRegistrationNumber() {
    let digits = "";
    for (let i = 0; i < 11; i++) digits += crypto.randomInt(0, 10);
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const first = letters[crypto.randomInt(0, letters.length)];
    const second = letters[crypto.randomInt(0, letters.length)];
    return digits + first + second;
}

function isValidRegistrationNumber(value) {
    return typeof value === "string" && /^\d{11}[A-Z]{2}$/.test(value);
}

/* =========================================================
   FIRESTORE REG NUMBER CHECK
========================================================= */

async function registrationNumberExists(regNumber) {
    const snapshot = await db.collection("cbt_submissions")
        .where("regNumber", "==", regNumber)
        .limit(1).get();
    if (!snapshot.empty) return true;

    const legacySnapshot = await db.collection("cbt_submissions")
        .where("candidate.regNumber", "==", regNumber)
        .limit(1).get();
    return !legacySnapshot.empty;
}

async function ensureRegistrationNumber(submissionDoc) {
    const ref = db.collection("cbt_submissions").doc(submissionDoc.id);
    const current = submissionDoc.data();

    if (isValidRegistrationNumber(current.regNumber)) return current.regNumber;
    if (isValidRegistrationNumber(current.candidate?.regNumber)) return current.candidate.regNumber;

    let newRegNumber;
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = generateRegistrationNumber();
        if (!(await registrationNumberExists(candidate))) {
            newRegNumber = candidate;
            break;
        }
    }

    if (!newRegNumber) throw new Error("Unable to generate a unique registration number.");

    await db.runTransaction(async transaction => {
        const fresh = await transaction.get(ref);
        if (!fresh.exists) throw new Error("Submission no longer exists.");
        const freshData = fresh.data();
        if (isValidRegistrationNumber(freshData.regNumber)) {
            newRegNumber = freshData.regNumber;
            return;
        }
        transaction.update(ref, {
            regNumber: newRegNumber,
            regNumberCreatedAt: Timestamp.now()
        });
    });
    return newRegNumber;
}

/* =========================================================
   DATE HELPERS
========================================================= */

function getTimestampMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    if (typeof value === "object" && typeof value._seconds === "number") {
        return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
    }
    return 0;
}

/* =========================================================
   PHONE VARIANTS
========================================================= */

function phoneVariants(phone) {
    const normalized = normalizePhoneNumber(phone);
    const variants = new Set();
    if (!normalized) return [];
    variants.add(normalized);
    if (normalized.startsWith("234") && normalized.length === 13) {
        variants.add("0" + normalized.substring(3));
    }
    return [...variants];
}

/* =========================================================
   FIND CANDIDATE RESULT
========================================================= */

async function findCandidateResult(phone) {
    const variants = phoneVariants(phone);
    if (!variants.length) return null;

    const results = [];
    const snapshot = await db.collection("cbt_submissions")
        .where("candidate.whatsapp", "in", variants).get();

    snapshot.forEach(doc => results.push({ id: doc.id, data: doc.data() }));

    if (!results.length) {
        for (const variant of variants) {
            const fallback = await db.collection("cbt_submissions")
                .where("candidateWhatsApp", "==", variant).get();
            fallback.forEach(doc => results.push({ id: doc.id, data: doc.data() }));
        }
    }

    if (!results.length) return null;

    results.sort((a, b) =>
        getTimestampMillis(b.data.submittedAt) - getTimestampMillis(a.data.submittedAt)
    );
    return results[0];
}

/* =========================================================
   FETCH QUESTION BANK
========================================================= */

async function fetchQuestionBank(subject) {
    const filename = subjectFileMap[subject];
    if (!filename) throw new Error(`No question bank found for ${subject}`);

    const url = `\( {QUESTION_BANK_BASE_URL}/ \){encodeURIComponent(filename)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load ${subject} question bank. HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`${subject} question bank is not an array.`);
    return data.slice(0, 15);
}

/* =========================================================
   ANSWER NORMALIZATION
========================================================= */

function normalizeAnswerIndex(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) return value;
    if (typeof value === "string") {
        const upper = value.trim().toUpperCase();
        if (["A", "B", "C", "D"].includes(upper)) return upper.charCodeAt(0) - 65;
        const number = Number(value);
        if (Number.isInteger(number) && number >= 0 && number <= 3) return number;
    }
    return null;
}

/* =========================================================
   SUBJECT SCORING
========================================================= */

async function calculateSubjectScores(submission) {
    const data = submission.data;
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const answers = data.answers || {};

    const subjectScores = [];

    for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex++) {
        const subject = subjects[subjectIndex];
        const questions = await fetchQuestionBank(subject);
        let rawScore = 0;

        for (let localIndex = 0; localIndex < questions.length && localIndex < 15; localIndex++) {
            const question = questions[localIndex];
            const globalIndex = subjectIndex * 15 + localIndex;

            let selected = answers[globalIndex];
            if (selected === undefined || selected === null) {
                selected = answers[String(globalIndex)];
            }

            const selectedIndex = normalizeAnswerIndex(selected);
            if (selectedIndex === null) continue;

            const correct = String(question.answer || "").trim().toUpperCase();
            const correctIndex = correct.charCodeAt(0) - 65;

            if (selectedIndex === correctIndex) rawScore++;
        }

        const scoreOutOf100 = Math.round((rawScore / 15) * 100);
        subjectScores.push({
            subject, rawScore, totalQuestions: 15, score: scoreOutOf100
        });
    }

    const aggregate = subjectScores.reduce((total, item) => total + item.score, 0);
    return { subjectScores, aggregate };
}

/* =========================================================
   RESULT MESSAGE
========================================================= */

function buildResultMessage({ name, regNumber, subjectScores, aggregate }) {
    let message = `Dear ${name},\n\nReg Number: ${regNumber}\n\nYour 2027 UTME Mock Result:\n\n`;
    for (const item of subjectScores) {
        message += `${item.subject}: ${item.score}/100\n`;
    }
    message += `\nAggregate: ${aggregate}/400\n\nThank you for participating in the Flexi Educational Consult Weekly CBT Mock.`;
    return message;
}

/* =========================================================
   MOCKRESULT COMMAND PARSER
========================================================= */

function parseMockResultCommand(text) {
    if (!text) return null;
    const cleaned = String(text).trim();
    const match = cleaned.match(/^MOCKRESULT\s*[:\-]?\s*(\+?\d{10,15})$/i);
    if (!match) return null;
    return normalizePhoneNumber(match[1]);
}

/* =========================================================
   DASHBOARD HTML (UPDATED)
========================================================= */

const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flexi MockResult Bot</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #07110d; color: #ffffff; }
.container { width: 100%; max-width: 650px; margin: auto; padding: 20px; }
card { background: #0d1d17; border: 1px solid #1e3b2e; border-radius: 18px; padding: 22px; margin-top: 20px; box-shadow: 0 15px 40px rgba(0,0,0,.35); }
h1 { margin-top: 0; color: #5ee59a; }
h2 { margin-top: 0; }
label { display: block; margin-bottom: 8px; font-weight: bold; }
input { width: 100%; padding: 15px; border-radius: 10px; border: 1px solid #315642; background: #06100c; color: white; font-size: 16px; outline: none; }
input:focus { border-color: #5ee59a; }
button { width: 100%; padding: 15px; margin-top: 15px; border: none; border-radius: 10px; background: #159447; color: white; font-size: 16px; font-weight: bold; cursor: pointer; }
button:hover { background: #1aad55; }
.status { padding: 14px; border-radius: 10px; background: #06100c; margin-top: 15px; }
.code { font-size: 32px; text-align: center; letter-spacing: 5px; font-weight: bold; color: #5ee59a; padding: 20px; background: #06100c; border-radius: 12px; margin-top: 15px; word-break: break-all; }
.small { color: #9fb3a8; font-size: 14px; line-height: 1.5; }
.hidden { display: none; }
.error { color: #ff7777; }
.success { color: #5ee59a; }
</style>
</head>
<body>
<div class="container">
<div class="card">
<h1>Flexi MockResult Bot</h1>
<p class="small">Pair your WhatsApp number with the bot using WhatsApp's pairing-code system.</p>
<label>Dashboard Password</label>
<input id="password" type="password" value="" placeholder="Enter dashboard password">
<label style="margin-top:15px;">WhatsApp Number</label>
<input id="phone" type="tel" placeholder="08012345678 or 2348012345678">
<button onclick="pairBot()">GENERATE PAIRING CODE</button>
<button onclick="forceCheckStatus()" style="background:#555; margin-left:10px;">🔄 Refresh Status</button>
<div id="message" class="status hidden"></div>
<div id="codeBox" class="hidden">
<h2>Pairing Code</h2>
<div id="pairingCode" class="code"></div>
<p class="small">Open WhatsApp on the phone you entered, go to Linked Devices → Link a Device → Link with phone number instead, then enter the code above.</p>
</div>
</div>
<div class="card">
<h2>Bot Status</h2>
<div class="status"><strong>Status:</strong> <span id="connection">Loading...</span></div>
<div class="status"><strong>Paired Number:</strong> <span id="botNumber">-</span></div>
<div class="status"><strong>Pairing:</strong> <span id="pairingStatus">-</span></div>
</div>
<div class="card">
<h2>Command</h2>
<p class="small">Students can send:</p>
<div class="status">MOCKRESULT08012345678</div>
<p class="small">or</p>
<div class="status">MOCKRESULT 08012345678</div>
</div>
</div>
<script>
let password = "";
function showMessage(text, type = "") {
    const box = document.getElementById("message");
    box.textContent = text;
    box.className = "status " + type;
}
async function pairBot() {
    password = document.getElementById("password").value;
    const phone = document.getElementById("phone").value.trim();
    if (!password) { showMessage("Enter dashboard password.", "error"); return; }
    if (!phone) { showMessage("Enter the WhatsApp number.", "error"); return; }
    showMessage("Requesting pairing code...", "warning");
    try {
        const response = await fetch("/api/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-dashboard-password": password },
            body: JSON.stringify({ phone })
        });
        const data = await response.json();
        if (!response.ok) { throw new Error(data.message || "Pairing failed."); }
        if (data.code) {
            document.getElementById("pairingCode").textContent = data.code;
            document.getElementById("codeBox").classList.remove("hidden");
        }
        showMessage(data.message || "Pairing code generated.", "success");
        loadStatus();
    } catch (error) {
        showMessage(error.message, "error");
    }
}
async function forceCheckStatus() {
    if (!password) return;
    try {
        const response = await fetch("/api/status", {
            headers: { "x-dashboard-password": password }
        });
        if (!response.ok) return;
        const data = await response.json();
        document.getElementById("connection").textContent = data.connectionState;
        document.getElementById("botNumber").textContent = data.phone || "-";
        document.getElementById("pairingStatus").textContent = data.pairingInProgress ? "In progress" : "Not active";
        if (data.pairingCode) {
            document.getElementById("pairingCode").textContent = data.pairingCode;
            document.getElementById("codeBox").classList.remove("hidden");
        }
    } catch (error) { console.error(error); }
}
async function loadStatus() {
    forceCheckStatus();
}
document.getElementById("password").addEventListener("change", () => { password = document.getElementById("password").value; loadStatus(); });
setInterval(loadStatus, 5000);
</script>
</body>
</html>
`;

/* =========================================================
   DASHBOARD ROUTES
========================================================= */

app.get("/", (req, res) => res.send(dashboardHTML));

app.get("/api/status", dashboardAuth, (req, res) => {
    res.json({
        success: true,
        connectionState,
        phone: currentPairingNumber || jidToPhone(sock?.user?.id),
        pairingInProgress,
        pairingCode,
        lastConnectionUpdate
    });
});

/* =========================================================
   PAIRING - FIXED (2026 Block Fix)
========================================================= */

app.post("/api/pair", dashboardAuth, async (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.body.phone);

        if (!isValidWhatsAppNumber(phone)) {
            return res.status(400).json({ success: false, message: "Enter a valid WhatsApp number." });
        }

        if (pairingInProgress) {
            return res.status(409).json({ success: false, message: "A pairing request is already in progress." });
        }

        currentPairingNumber = phone;
        pairingInProgress = true;

        // FIXED: Do NOT force restart or call end() — this was causing the 428 loop
        await startWhatsApp(false);

        let attempts = 0;
        while (attempts < 20) {
            attempts++;
            if (sock && typeof sock.requestPairingCode === "function") break;
            await new Promise(r => setTimeout(r, 800));
        }

        if (!sock || typeof sock.requestPairingCode !== "function") {
            pairingInProgress = false;
            return res.status(500).json({ success: false, message: "Socket not ready for pairing." });
        }

        const code = await sock.requestPairingCode(phone);
        pairingCode = code;

        return res.json({
            success: true,
            code,
            phone,
            message: "Pairing code generated! (Note: 2026 WhatsApp blocks many automated attempts)"
        });

    } catch (error) {
        pairingInProgress = false;
        console.error("PAIRING ERROR:", error);
        return res.status(500).json({ success: false, message: error.message || "Pairing failed" });
    }
});

/* =========================================================
   WHATSAPP START - IMPROVED
========================================================= */

async function startWhatsApp(forceRestart = false) {
    if (botStarting && !forceRestart) return;

    botStarting = true;

    try {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

        let version;
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
            logger.info({ version }, "Using latest Baileys WhatsApp version");
        } catch (e) {
            logger.warn("Could not fetch latest WhatsApp version. Using Baileys default.");
        }

        sock = makeWASocket({
            ...(version ? { version } : {}),
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger,
            browser: Browsers.macOS("Desktop"),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect } = update;

            if (connection) {
                connectionState = connection;
                lastConnectionUpdate = new Date().toISOString();
                logger.info(`WhatsApp connection: ${connection}`);
            }

            if (connection === "open") {
                pairingInProgress = false;
                pairingCode = "";
                currentPairingNumber = jidToPhone(sock?.user?.id) || currentPairingNumber;
                logger.info(`WhatsApp connected as ${currentPairingNumber}`);
            }

            if (connection === "close") {
                pairingInProgress = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                logger.warn({ statusCode, shouldReconnect }, "WhatsApp connection closed");

                if (shouldReconnect) {
                    scheduleReconnect();
                } else {
                    logger.error("WhatsApp logged out. Delete auth folder and pair again.");
                    connectionState = "logged_out";
                }
            }
        });

        sock.ev.on("messages.upsert", async event => {
            try {
                if (event.type !== "notify") return;
                for (const message of event.messages) {
                    await handleIncomingMessage(message);
                }
            } catch (error) {
                logger.error({ error: error.message }, "Message handler error");
            }
        });

    } catch (error) {
        logger.error({ error: error.message }, "WhatsApp startup error");
        connectionState = "error";
    } finally {
        botStarting = false;
    }
}

/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            await startWhatsApp();
        } catch (error) {
            logger.error(error);
        }
    }, 5000);
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleIncomingMessage(message) {
    if (!message) return;
    if (message.key.fromMe) return;
    const remoteJid = message.key.remoteJid;
    if (!remoteJid) return;
    if (remoteJid.endsWith("@g.us")) return;
    if (remoteJid === "status@broadcast") return;

    const text = extractMessageText(message);
    if (!text) return;

    const phone = parseMockResultCommand(text);
    if (!phone) return;

    logger.info(`Result request received for ${phone}`);

    try {
        await sock.sendMessage(remoteJid, { text: "🔎 Checking your mock result, please wait..." });

        const submission = await findCandidateResult(phone);
        if (!submission) {
            await sock.sendMessage(remoteJid, {
                text: "❌ No mock result was found for this WhatsApp number.\n\nPlease make sure you entered the same number used during registration."
            });
            return;
        }

        const regNumber = await ensureRegistrationNumber(submission);
        const scores = await calculateSubjectScores(submission);

        const name = submission.data?.candidate?.name || submission.data?.candidateName || "Candidate";
        const resultMessage = buildResultMessage({
            name, regNumber, subjectScores: scores.subjectScores, aggregate: scores.aggregate
        });

        await sock.sendMessage(remoteJid, { text: resultMessage });
    } catch (error) {
        logger.error({ error: error.message, phone }, "Result processing error");
        await sock.sendMessage(remoteJid, {
            text: "❌ Sorry, we could not process your result right now. Please try again later."
        });
    }
}

/* =========================================================
   EXTRACT MESSAGE TEXT
========================================================= */

function extractMessageText(message) {
    const msg = message.message;
    if (!msg) return "";
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return "";
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        service: "Flexi MockResult Bot",
        connectionState,
        timestamp: new Date().toISOString()
    });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
    console.log(`
========================================
 FLEXI MOCKRESULT BOT
========================================

Dashboard:
http://localhost:${PORT}

Password:
admin

Question Bank:
${QUESTION_BANK_BASE_URL}

Firestore:
cbt_submissions

Result Command:
MOCKRESULT08012345678

========================================
`);
});

/* =========================================================
   START WHATSAPP
========================================================= */

startWhatsApp()
    .catch(error => console.error("Initial WhatsApp startup failed:", error));

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    try { if (sock) sock.end(new Error("Server shutting down")); } catch (_) {}
    process.exit(0);
});

process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    try { if (sock) sock.end(new Error("Server shutting down")); } catch (_) {}
    process.exit(0);
});
