const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const pino = require('pino');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

// Initialize Firebase Admin SDK using FIREBASE_SERVICE_ACCOUNT env variable
let firebaseApp = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (e) {
            // Handle escaped newlines or stringified json if needed
            serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
        }
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        console.error("CRITICAL: FIREBASE_SERVICE_ACCOUNT is missing from environment variables.");
    }
} catch (error) {
    console.error("Failed to initialize Firebase Admin:", error);
}

const db = firebaseApp ? admin.firestore() : null;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');
const QUESTION_BANK_BASE_URL = "https://raw.githubusercontent.com/flexisystems2000/Weekly-CBT-Mock-/main/questions";

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

// Global Baileys connection state trackers
let sock = null;
let connectionStateStatus = "Disconnected";
let pairedWhatsAppNumber = "None";
let pairingStatus = "Idle";
let currentPairingCode = null;
let lastConnectionUpdate = "Never";

// Cache for question bank files to avoid redundant network calls
const questionCache = {};

async function fetchSubjectQuestions(subjectName) {
    const fileName = subjectFileMap[subjectName];
    if (!fileName) return null;
    if (questionCache[subjectName]) return questionCache[subjectName];

    try {
        const url = `${QUESTION_BANK_BASE_URL}/${fileName}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        // Take the first 15 questions per subject matching CBT logic
        const questions = Array.isArray(data) ? data.slice(0, 15) : (data.questions ? data.questions.slice(0, 15) : []);
        questionCache[subjectName] = questions;
        return questions;
    } catch (err) {
        console.error(`Error fetching question bank for ${subjectName}:`, err);
        return null;
    }
}

function normalizePhoneNumber(rawNumber) {
    let cleaned = rawNumber.replace(/\D/g, '');
    if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = '234' + cleaned.substring(1);
    }
    return cleaned;
}

function generateRegNumber() {
    const digits = Math.floor(10000000000 + Math.random() * 90000000000).toString(); // 11 digits
    const letters = String.fromCharCode(65 + Math.floor(Math.random() * 26)) + 
                    String.fromCharCode(65 + Math.floor(Math.random() * 26)); // 2 uppercase letters
    return digits + letters;
}

async function startWhatsAppSession(targetPhoneNumber = null) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Flexi MockResult Bot", "Chrome", "120.0.0.0"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            lastConnectionUpdate = new Date().toISOString();

            if (connection) {
                connectionStateStatus = connection;
            }

            if (connection === 'open') {
                pairingStatus = "Connected Successfully";
                currentPairingCode = null;
                console.log("WhatsApp connection opened successfully.");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    connectionStateStatus = "Logged Out";
                    pairingStatus = "Logged Out - Re-pairing Required";
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    } catch (e) {}
                } else {
                    connectionStateStatus = "Disconnected";
                    setTimeout(() => startWhatsAppSession(), 5000);
                }
            }

            // Handle pairing code request if target number is supplied and not registered
            if (targetPhoneNumber && !sock.authState.creds.registered) {
                if (pairingStatus !== "Generating...") {
                    pairingStatus = "Generating...";
                    try {
                        // Small delay to let socket initialize connection handshake
                        setTimeout(async () => {
                            try {
                                const code = await sock.requestPairingCode(targetPhoneNumber);
                                currentPairingCode = code;
                                pairedWhatsAppNumber = targetPhoneNumber;
                                pairingStatus = "Pairing Code Generated";
                            } catch (err) {
                                pairingStatus = "Failed to generate code: " + err.message;
                            }
                        }, 3000);
                    } catch (e) {
                        pairingStatus = "Error: " + e.message;
                    }
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                // Private chats only - ignore groups and statuses
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) {
                    continue;
                }

                const textContent = msg.message.conversation || 
                                    msg.message.extendedTextMessage?.text || 
                                    msg.message.imageMessage?.caption || '';

                const cleanedText = textContent.trim();
                const mockResultRegex = /^mockresult[:\s]*(\d+)/i;
                const match = cleanedText.match(mockResultRegex);

                if (match) {
                    const rawPhone = match[1];
                    const normalizedPhone = normalizePhoneNumber(rawPhone);
                    await handleResultRequest(remoteJid, normalizedPhone, msg);
                }
            }
        });

    } catch (err) {
        console.error("Error starting WhatsApp session:", err);
    }
}

async function handleResultRequest(remoteJid, phoneNumber, originalMsg) {
    if (!db) {
        await sock.sendMessage(remoteJid, { text: "Service configuration error. Firebase database not connected." }, { quoted: originalMsg });
        return;
    }

    try {
        // Query Firestore cbt_submissions collection
        const submissionsRef = db.collection('cbt_submissions');
        
        // Try matching primary candidate.whatsapp field
        let snapshot = await submissionsRef.where('candidate.whatsapp', '==', phoneNumber).get();
        
        // Fallback checks for alternative structures if empty
        if (snapshot.empty) {
            snapshot = await submissionsRef.where('candidateWhatsApp', '==', phoneNumber).get();
        }

        if (snapshot.empty) {
            // Try matching local or international format variations
            const altPhone = phoneNumber.startsWith('234') ? phoneNumber.substring(3) : '234' + phoneNumber;
            snapshot = await submissionsRef.where('candidate.whatsapp', '==', altPhone).get();
        }

        if (snapshot.empty) {
            await sock.sendMessage(remoteJid, { 
                text: "No mock result was found for this WhatsApp number. Please make sure you entered the same number used during registration." 
            }, { quoted: originalMsg });
            return;
        }

        // Select the latest submission using submittedAt
        let docs = snapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, data: doc.data() }));
        docs.sort((a, b) => {
            const timeA = a.data.submittedAt?.toMillis ? a.data.submittedAt.toMillis() : (new Date(a.data.submittedAt || 0).getTime());
            const timeB = b.data.submittedAt?.toMillis ? b.data.submittedAt.toMillis() : (new Date(b.data.submittedAt || 0).getTime());
            return timeB - timeA;
        });

        const latestDoc = docs[0];
        const submission = latestDoc.data;

        // Check/Generate Registration Number
        let regNumber = submission.regNumber || submission.candidate?.regNumber;
        if (!regNumber || !/^\d{11}[A-Z]{2}$/.test(regNumber)) {
            // Ensure uniqueness across Firestore
            let isUnique = false;
            while (!isUnique) {
                regNumber = generateRegNumber();
                const existingCheck = await submissionsRef.where('regNumber', '==', regNumber).get();
                if (existingCheck.empty) {
                    isUnique = true;
                }
            }
            // Save back to Firestore document
            await latestDoc.ref.update({ regNumber: regNumber });
        }

        const candidateName = submission.candidate?.name || "Candidate";
        const subjects = submission.subjects || [];
        const answers = submission.answers || {};

        let subjectBreakdownText = "";
        let aggregateScore = 0;

        for (let sIdx = 0; sIdx < subjects.length; sIdx++) {
            const subjectName = subjects[sIdx];
            const questions = await fetchSubjectQuestions(subjectName);
            
            let rawSubjectScore = 0;
            if (questions && questions.length > 0) {
                for (let qIdx = 0; qIdx < questions.length; qIdx++) {
                    const globalIndex = sIdx * 15 + qIdx;
                    const candidateAnswerIndex = answers[globalIndex] !== undefined ? answers[globalIndex] : answers[globalIndex.toString()];
                    
                    if (candidateAnswerIndex !== undefined && candidateAnswerIndex !== null) {
                        const correctLetter = questions[qIdx].answer; // e.g. "A", "B", "C", "D"
                        const optionMapping = { 0: "A", 1: "B", 2: "C", 3: "D" };
                        const candidateLetter = optionMapping[candidateAnswerIndex];
                        
                        if (candidateLetter && candidateLetter === correctLetter) {
                            rawSubjectScore++;
                        }
                    }
                }
            }

            const subjectScore = Math.round((rawSubjectScore / 15) * 100);
            aggregateScore += subjectScore;
            subjectBreakdownText += `${subjectName}: ${subjectScore}/100\n`;
        }

        const responseMessage = `Dear ${candidateName}, Reg Number: ${regNumber} Your 2027 UTME Mock Result:\n${subjectBreakdownText}Aggregate: ${aggregateScore}/400\nThank you for participating in the Flexi Educational Consult Weekly CBT Mock.`;

        await sock.sendMessage(remoteJid, { text: responseMessage.trim() }, { quoted: originalMsg });

    } catch (err) {
        console.error("Error processing result request:", err);
        await sock.sendMessage(remoteJid, { text: "An error occurred while retrieving your mock result. Please try again later." }, { quoted: originalMsg });
    }
}

// Express Dashboard Routes
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Flexi MockResult Bot Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial, sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
                .container { max-width: 600px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #075e54; font-size: 24px; margin-top: 0; }
                .status-box { background: #ecfaf6; border-left: 4px solid #25d366; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
                .form-group { margin-bottom: 15px; }
                label { display: block; margin-bottom: 5px; font-weight: bold; }
                input[type="text"], input[type="password"] { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
                button { background: #25d366; color: white; border: none; padding: 10px 20px; font-size: 16px; border-radius: 4px; cursor: pointer; width: 100%; }
                button:hover { background: #128c7e; }
                .code-display { font-size: 28px; font-weight: bold; letter-spacing: 3px; color: #075e54; text-align: center; background: #f0f0f0; padding: 15px; border-radius: 4px; margin-top: 15px; }
                .instructions { font-size: 14px; color: #555; background: #fff8e1; padding: 10px; border-radius: 4px; margin-top: 15px; border-left: 4px solid #ffc107; }
                .login-screen { max-width: 400px; margin: 50px auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            </style>
        </head>
        <body>
            <div class="container" id="dashboard" style="display:none;">
                <h1>Flexi MockResult Bot Dashboard</h1>
                <div class="status-box">
                    <p><strong>Connection Status:</strong> <span id="conn-status">Loading...</span></p>
                    <p><strong>Paired Number:</strong> <span id="paired-num">Loading...</span></p>
                    <p><strong>Pairing Status:</strong> <span id="pairing-status">Loading...</span></p>
                    <p><strong>Last Update:</strong> <span id="last-update">Loading...</span></p>
                </div>
                <div class="form-group">
                    <label for="whatsapp-input">WhatsApp Number</label>
                    <input type="text" id="whatsapp-input" placeholder="e.g. 08012345678">
                </div>
                <button onclick="generatePairingCode()">Generate Pairing Code</button>
                <div id="code-container" style="display:none;">
                    <div class="code-display" id="pairing-code-val">----</div>
                </div>
                <div class="instructions">
                    <strong>How to link:</strong> Open WhatsApp &rarr; Linked Devices &rarr; Link a Device &rarr; Link with phone number instead, then enter the code above.
                </div>
            </div>

            <div class="login-screen" id="login-box">
                <h1>Admin Login</h1>
                <div class="form-group">
                    <label for="password-input">Password</label>
                    <input type="password" id="password-input" placeholder="Enter admin password">
                </div>
                <button onclick="login()">Login</button>
            </div>

            <script>
                function login() {
                    const pwd = document.getElementById('password-input').value;
                    if(pwd === 'admin') {
                        document.getElementById('login-box').style.display = 'none';
                        document.getElementById('dashboard').style.display = 'block';
                        fetchStatus();
                        setInterval(fetchStatus, 4000);
                    } else {
                        alert('Incorrect password');
                    }
                }

                async function fetchStatus() {
                    try {
                        const res = await fetch('/api/status');
                        const data = await res.json();
                        document.getElementById('conn-status').innerText = data.connectionStateStatus;
                        document.getElementById('paired-num').innerText = data.pairedWhatsAppNumber;
                        document.getElementById('pairing-status').innerText = data.pairingStatus;
                        document.getElementById('last-update').innerText = data.lastConnectionUpdate;
                        if(data.currentPairingCode) {
                            document.getElementById('code-container').style.display = 'block';
                            document.getElementById('pairing-code-val').innerText = data.currentPairingCode;
                        }
                    } catch(e) {}
                }

                async function generatePairingCode() {
                    let rawNum = document.getElementById('whatsapp-input').value.trim();
                    if(!rawNum) {
                        alert('Please enter a valid WhatsApp number');
                        return;
                    }
                    if(rawNum.startsWith('0') && rawNum.length === 11) {
                        rawNum = '234' + rawNum.substring(1);
                    }
                    document.getElementById('pairing-status').innerText = 'Requesting pairing code...';
                    try {
                        const res = await fetch('/api/pair', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: rawNum, password: 'admin' })
                        });
                        const data = await res.json();
                        if(!data.success) {
                            alert(data.message || 'Failed to request pairing code');
                        } else {
                            fetchStatus();
                        }
                    } catch(e) {
                        alert('Error requesting pairing code');
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/api/status', (req, res) => {
    res.json({
        connectionStateStatus,
        pairedWhatsAppNumber,
        pairingStatus,
        currentPairingCode,
        lastConnectionUpdate
    });
});

app.post('/api/pair', async (req, res) => {
    const { phone, password } = req.body;
    if (password !== 'admin') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number required' });
    }

    try {
        if (sock) {
            try { await sock.logout(); } catch (e) {}
        }
        try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        } catch (e) {}

        pairingStatus = "Initializing pairing...";
        currentPairingCode = null;
        await startWhatsAppSession(phone);
        res.json({ success: true, message: 'Pairing process initiated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        ok: true, 
        service: "Flexi MockResult Bot", 
        connectionState: connectionStateStatus 
    });
});

app.listen(PORT, () => {
    console.log(`Flexi MockResult Bot server running on port ${PORT}`);
    // Automatically start WhatsApp session on boot if credentials exist
    startWhatsAppSession();
});
