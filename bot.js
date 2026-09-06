require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

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
const QUESTION_BANK_BASE_URL = "https://raw.githubusercontent.com/flexisystems2000/Weekly-CBT-Mock-/main/questions";
const AUTH_FOLDER = process.env.AUTH_FOLDER || "./auth_info_baileys";
const LOG_LEVEL = "info";

const logger = pino({ level: LOG_LEVEL });

/* =========================================================
   FIREBASE
========================================================= */

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("ERROR: FIREBASE_SERVICE_ACCOUNT is missing");
    process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

/* =========================================================
   QUESTION BANK
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
   EXPRESS + AUTH
========================================================= */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function dashboardAuth(req, res, next) {
    const password = req.headers["x-dashboard-password"] || req.query.password || req.body?.password;
    if (password !== DASHBOARD_PASSWORD) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
}

function normalizePhoneNumber(n) {
    if (!n) return "";
    let phone = String(n).trim().replace(/[^\d+]/g, "");
    if (phone.startsWith("+")) phone = phone.substring(1);
    if (phone.startsWith("0") && phone.length === 11) phone = "234" + phone.substring(1);
    return phone;
}

function isValidWhatsAppNumber(n) { return /^\d{10,15}$/.test(n); }
function jidToPhone(jid) {
    if (!jid) return "";
    return String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/* =========================================================
   REGISTRATION NUMBER HELPERS
========================================================= */

function generateRegistrationNumber() {
    let digits = ""; for (let i = 0; i < 11; i++) digits += crypto.randomInt(0, 10);
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const first = letters[crypto.randomInt(0, letters.length)];
    const second = letters[crypto.randomInt(0, letters.length)];
    return digits + first + second;
}

function isValidRegistrationNumber(v) { return typeof v === "string" && /^\d{11}[A-Z]{2}$/.test(v); }

async function registrationNumberExists(regNumber) {
    const s1 = await db.collection("cbt_submissions").where("regNumber", "==", regNumber).limit(1).get();
    if (!s1.empty) return true;
    const s2 = await db.collection("cbt_submissions").where("candidate.regNumber", "==", regNumber).limit(1).get();
    return !s2.empty;
}

async function ensureRegistrationNumber(submissionDoc) {
    const ref = db.collection("cbt_submissions").doc(submissionDoc.id);
    const data = submissionDoc.data();
    if (isValidRegistrationNumber(data.regNumber)) return data.regNumber;
    if (isValidRegistrationNumber(data.candidate?.regNumber)) return data.candidate.regNumber;

    let newReg;
    for (let i = 0; i < 20; i++) {
        const candidate = generateRegistrationNumber();
        if (!(await registrationNumberExists(candidate))) { newReg = candidate; break; }
    }
    if (!newReg) throw new Error("Unable to generate unique reg number");

    await db.runTransaction(async t => {
        const fresh = await t.get(ref);
        if (!fresh.exists) throw new Error("Submission gone");
        const d = fresh.data();
        if (isValidRegistrationNumber(d.regNumber)) { newReg = d.regNumber; return; }
        t.update(ref, { regNumber: newReg, regNumberCreatedAt: Timestamp.now() });
    });
    return newReg;
}

/* =========================================================
   HELPERS
========================================================= */

function getTimestampMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const p = Date.parse(v); return Number.isNaN(p) ? 0 : p;
    }
    if (typeof v === "object" && typeof v._seconds === "number") return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1000000);
    return 0;
}

function phoneVariants(phone) {
    const n = normalizePhoneNumber(phone);
    const s = new Set();
    if (!n) return [];
    s.add(n);
    if (n.startsWith("234") && n.length === 13) s.add("0" + n.substring(3));
    return [...s];
}

async function findCandidateResult(phone) {
    const variants = phoneVariants(phone);
    if (!variants.length) return null;

    const results = [];
    const snap = await db.collection("cbt_submissions").where("candidate.whatsapp", "in", variants).get();
    snap.forEach(d => results.push({ id: d.id, data: d.data() }));

    if (results.length === 0) {
        for (const v of variants) {
            const fb = await db.collection("cbt_submissions").where("candidateWhatsApp", "==", v).get();
            fb.forEach(d => results.push({ id: d.id, data: d.data() }));
        }
    }
    if (results.length === 0) return null;

    results.sort((a, b) => getTimestampMillis(b.data.submittedAt) - getTimestampMillis(a.data.submittedAt));
    return results[0];
}

async function fetchQuestionBank(subject) {
    const file = subjectFileMap[subject];
    if (!file) throw new Error(`No bank for ${subject}`);
    const url = `\( {QUESTION_BANK_BASE_URL}/ \){encodeURIComponent(file)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${subject}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error(`${subject} bank not array`);
    return data.slice(0, 15);
}

function normalizeAnswerIndex(v) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3) return v;
    if (typeof v === "string") {
        const u = v.trim().toUpperCase();
        if (["A","B","C","D"].includes(u)) return u.charCodeAt(0) - 65;
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
    }
    return null;
}

async function calculateSubjectScores(submission) {
    const data = submission.data;
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const answers = data.answers || {};

    const scores = [];
    for (let i = 0; i < subjects.length; i++) {
        const subject = subjects[i];
        const qs = await fetchQuestionBank(subject);
        let score = 0;
        for (let j = 0; j < qs.length && j < 15; j++) {
            const q = qs[j];
            const idx = i * 15 + j;
            let sel = answers[idx];
            if (sel === undefined || sel === null) sel = answers[String(idx)];
            const chosen = normalizeAnswerIndex(sel);
            if (chosen === null) continue;
            const correct = String(q.answer || "").trim().toUpperCase();
            const corrIdx = correct.charCodeAt(0) - 65;
            if (chosen === corrIdx) score++;
        }
        const perc = Math.round((score / 15) * 100);
        scores.push({ subject, rawScore: score, totalQuestions: 15, score: perc });
    }
    const aggregate = scores.reduce((a, c) => a + c.score, 0);
    return { subjectScores: scores, aggregate };
}

function buildResultMessage({ name, regNumber, subjectScores, aggregate }) {
    let msg = `Dear ${name},\n\nReg Number: ${regNumber}\n\nYour 2027 UTME Mock Result:\n\n`;
    subjectScores.forEach(s => { msg += `${s.subject}: ${s.score}/100\n`; });
    msg += `\nAggregate: ${aggregate}/400\n\nThank you for participating in the Flexi Educational Consult Weekly CBT Mock.`;
    return msg;
}

function parseMockResultCommand(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^MOCKRESULT\s*[:\-]?\s*(\+?\d{10,15})$/i);
    return m ? normalizePhoneNumber(m[1]) : null;
}

/* =========================================================
   DASHBOARD HTML
========================================================= */

const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flexi MockResult Bot</title>
<style>
* {box-sizing:border-box} body{margin:0;font-family:Arial;background:#07110d;color:#fff}
.container{width:100%;max-width:650px;margin:auto;padding:20px}
.card{background:#0d1d17;border:1px solid #1e3b2e;border-radius:18px;padding:22px;margin-top:20px;box-shadow:0 15px 40px rgba(0,0,0,.35)}
h1{margin-top:0;color:#5ee59a} h2{margin-top:0}
label{display:block;margin-bottom:8px;font-weight:bold}
input{width:100%;padding:15px;border-radius:10px;border:1px solid #315642;background:#06100c;color:white;font-size:16px;outline:none}
input:focus{border-color:#5ee59a}
button{width:100%;padding:15px;margin-top:15px;border:none;border-radius:10px;background:#159447;color:white;font-size:16px;font-weight:bold;cursor:pointer}
button:hover{background:#1aad55}
.status{padding:14px;border-radius:10px;background:#06100c;margin-top:15px}
.code{font-size:32px;text-align:center;letter-spacing:5px;font-weight:bold;color:#5ee59a;padding:20px;background:#06100c;border-radius:12px;margin-top:15px;word-break:break-all}
.small{color:#9fb3a8;font-size:14px;line-height:1.5}
.hidden{display:none}
.error{color:#ff7777}
.success{color:#5ee59a}
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
<button onclick="forceCheckStatus()" style="background:#555;margin-left:10px;">🔄 Refresh Status</button>
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
let password="";
function showMessage(t,type=""){const b=document.getElementById("message");b.textContent=t;b.className="status "+type;}
async function pairBot(){
    password=document.getElementById("password").value.trim();
    const phone=document.getElementById("phone").value.trim();
    if(!password){showMessage("Enter dashboard password.","error");return;}
    if(!phone){showMessage("Enter WhatsApp number.","error");return;}
    showMessage("Requesting pairing code...","warning");
    try{
        const r=await fetch("/api/pair",{method:"POST",headers:{"Content-Type":"application/json","x-dashboard-password":password},body:JSON.stringify({phone})});
        const d=await r.json();
        if(!r.ok) throw new Error(d.message||"Pairing failed");
        if(d.code){document.getElementById("pairingCode").textContent=d.code;document.getElementById("codeBox").classList.remove("hidden");}
        showMessage(d.message||"Pairing code generated.","success");
        forceCheckStatus();
    }catch(e){showMessage(e.message,"error");}
}
async function forceCheckStatus(){
    if(!password)return;
    try{
        const r=await fetch("/api/status",{headers:{"x-dashboard-password":password}});
        if(!r.ok)return;
        const d=await r.json();
        document.getElementById("connection").textContent=d.connectionState;
        document.getElementById("botNumber").textContent=d.phone||" - ";
        document.getElementById("pairingStatus").textContent=d.pairingInProgress?"In progress":"Not active";
        if(d.pairingCode){document.getElementById("pairingCode").textContent=d.pairingCode;document.getElementById("codeBox").classList.remove("hidden");}
    }catch(e){}
}
async function loadStatus(){forceCheckStatus();}
document.getElementById("password").addEventListener("change",()=>{password=document.getElementById("password").value;loadStatus();});
setInterval(loadStatus,5000);
</script>
</body>
</html>
`;

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req,res)=>res.send(dashboardHTML));

app.get("/api/status", dashboardAuth, (req,res)=>res.json({
    success:true, connectionState, phone: currentPairingNumber || jidToPhone(sock?.user?.id),
    pairingInProgress, pairingCode, lastConnectionUpdate
}));

app.post("/api/pair", dashboardAuth, async (req,res)=>{
    try{
        const phone = normalizePhoneNumber(req.body.phone);
        if(!isValidWhatsAppNumber(phone)) return res.status(400).json({success:false, message:"Valid WhatsApp number required"});

        if(pairingInProgress) return res.status(409).json({success:false, message:"Pairing already in progress"});

        currentPairingNumber = phone;
        pairingInProgress = true;

        await startWhatsApp(false);

        let attempts = 0;
        while(attempts < 25){
            attempts++;
            if(sock && typeof sock.requestPairingCode === "function") break;
            await new Promise(r => setTimeout(r, 600));
        }
        if(!sock || typeof sock.requestPairingCode !== "function"){
            pairingInProgress = false;
            return res.status
