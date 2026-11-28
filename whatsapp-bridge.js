const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '15mb' }));

// Security Layer: Never expose raw git repo or unauthenticated control endpoints on public internet
const ADMIN_PIN = process.env.ADMIN_PIN || '7860';
const IS_CLOUD = Boolean(process.env.GITHUB_ACTIONS || process.env.RENDER || process.env.VERCEL);

function maskSensitiveLog(msg) {
  if (!IS_CLOUD) return msg;
  // On cloud logs, mask middle digits of phone numbers and truncate private client chat content so logs remain end-to-end confidential
  return String(msg)
    .replace(/(\+?92\d{2})\d{5}(\d{3})/g, '$1*****$2')
    .replace(/(\d{4})\d{6,}(\d{3}@lid)/g, '$1******$2');
}

function getLiveCallBaseUrl(req) {
  if (process.env.PUBLIC_CALL_URL) return process.env.PUBLIC_CALL_URL.replace(/\/$/, '');
  const tunnelFile = path.join(__dirname, 'current_tunnel_url.txt');
  if (fs.existsSync(tunnelFile)) {
    const u = fs.readFileSync(tunnelFile, 'utf8').trim();
    if (u) return u.replace(/\/$/, '');
  }
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }
  return `http://localhost:${PORT}`;
}

const PORT = Number(process.env.PORT || 3001);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/whatsapp-incoming';
const CEO_PERSONAL_NUMBER = '923257938125@s.whatsapp.net'; // 0325-7938125
const BUSINESS_NUMBER = '923434762264@s.whatsapp.net';     // 0343-4762264
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MEMORY_FILE = path.join(__dirname, 'clients_memory.json');
const PERSONAL_ROSTER_FILE = path.join(__dirname, 'personal_0325_contacts.json');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe_voice.py');
const GENERATE_VOICE_SCRIPT = path.join(__dirname, 'generate_voice.py');
const GENERATE_POSTER_SCRIPT = path.join(__dirname, 'generate_poster.py');

// STRICT WHITELIST OF TRAVEL & VISA FOLDERS / FILES ONLY (Zero personal, university, or random files can ever be touched!)
const OFFICIAL_POSTER_DIRS = [
  '/home/test/Downloads/AL-BAHR_All_24_Umrah_Posters',
  path.join(__dirname, 'posters')
];

// Explicit whitelist of verified Travel & Visa PDFs/Posters in Downloads
const WHITELISTED_TRAVEL_FILES = [
  '/home/test/Downloads/DEEC GROUP PACKAGES.pdf',
  '/home/test/Downloads/UmrahGroups (2).pdf',
  '/home/test/Downloads/NOVEMBER PACKAGES UMRAH.pdf',
  '/home/test/Downloads/DEMAND FOR WORK VISA AND TOURISM .pdf',
  '/home/test/Downloads/EUROPEAN WORK VISA AND OTHERS .pdf',
  '/home/test/Downloads/Emerald Umrah Partnership Congratulations Card.png'
];

if (!fs.existsSync(path.join(__dirname, 'posters'))) {
  fs.mkdirSync(path.join(__dirname, 'posters'), { recursive: true });
}

// 1. Load Permanent Client Conversation Memory
let clientMemoryDB = {};
function loadClientMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      clientMemoryDB = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (e) {
    clientMemoryDB = {};
  }
}
function saveClientMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(clientMemoryDB, null, 2), 'utf8');
  } catch (e) {}
}
loadClientMemory();

// 2. Load 0325-7938125 Personal vs Client Classification Database
// Structure: { [jid]: { jid, name, phone, mode: 'pending' | 'personal' | 'client', lastMessage: '', lastIsVoice: false, updatedAt: '', promptedBoss: false } }
let personal0325Contacts = {};
function loadPersonal0325Contacts() {
  try {
    if (fs.existsSync(PERSONAL_ROSTER_FILE)) {
      personal0325Contacts = JSON.parse(fs.readFileSync(PERSONAL_ROSTER_FILE, 'utf8'));
    }
  } catch (e) {
    personal0325Contacts = {};
  }
}
function savePersonal0325Contacts() {
  try {
    fs.writeFileSync(PERSONAL_ROSTER_FILE, JSON.stringify(personal0325Contacts, null, 2), 'utf8');
  } catch (e) {}
}
loadPersonal0325Contacts();

// Track the most recent pending contact on 0325 so CEO can simply reply "1" (Personal) or "2" (Client) on WhatsApp
let lastPending0325Jid = null;

function guessHonorificFromName(fullName) {
  const n = (fullName || '').toLowerCase().trim();
  const femaleIndicators = [
    'fatima', 'ayesha', 'aisha', 'zainab', 'maryam', 'mariam', 'khadija', 'amina', 'amna',
    'sara', 'sarah', 'sana', 'hira', 'iqra', 'nimra', 'sidra', 'bushra', 'uzma', 'asma',
    'nadia', 'sadia', 'rabia', 'azia', 'faria', 'maria', 'sobia', 'shazia', 'nazia',
    'humaira', 'sumaira', 'tahira', 'zahra', 'zohra', 'noor', 'anam', 'anum', 'maham',
    'maheen', 'mehreen', 'ambreen', 'samreen', 'farheen', 'nosheen', 'shireen', 'parveen',
    'nasreen', 'yasmeen', 'komal', 'kiran', 'kinza', 'fiza', 'riza', 'aliza', 'aleeza',
    'hafsa', 'huma', 'lubna', 'rubina', 'samina', 'shabana', 'farzana', 'rukhsana',
    'sultana', 'rehana', 'farah', 'warda', 'areeba', 'laiba', 'habiba', 'muniba',
    'javeria', 'juveria', 'esha', 'isha', 'arooba', 'tooba', 'tuba', 'urooj', 'hina',
    'mina', 'bisma', 'rimsha', 'ramsha', 'ayman', 'aiman', 'eman', 'iman',
    'zoya', 'maya', 'saba', 'nida', 'rida', 'fida', 'huda', 'neha', 'sneha', 'pooja',
    'priya', 'anjali', 'miss', 'mrs', 'ms', 'bibi', 'begum', 'baji', 'api', 'queen',
    'princess', 'girl', 'lady', 'madam'
  ];

  const words = n.split(/[^a-z]+/).filter(Boolean);
  const isFemale = words.some(w => femaleIndicators.includes(w)) ||
    femaleIndicators.some(ind => ind.length >= 4 && n.includes(ind));

  if (isFemale) {
    return {
      gender: 'Female',
      enHonorific: 'Madam',
      urHonorific: 'محترمہ / میڈم',
      romanHonorific: 'Madam / Mohtarma'
    };
  }
  return {
    gender: 'Male',
    enHonorific: 'Sir',
    urHonorific: 'سر (Sir)',
    romanHonorific: 'Sir'
  };
}

function detectExactClientLanguage(text) {
  const clean = (text || '').trim();
  const arabicUrduChars = (clean.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (clean.match(/[a-zA-Z]/g) || []).length;

  if (arabicUrduChars > 2 && arabicUrduChars >= latinChars * 0.4) {
    return 'URDU_SCRIPT (اردو رسم الخط — Reply strictly in Urdu script!)';
  }

  const lower = clean.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const romanUrduVocab = new Set([
    'salam', 'aoa', 'kya', 'hai', 'hain', 'krna', 'karna', 'chahiye', 'chahye', 'chyia',
    'kitna', 'kitne', 'kesy', 'kaise', 'batao', 'batayen', 'bta', 'bhai', 'yar', 'mujhe',
    'mujy', 'mera', 'meri', 'lagta', 'kharcha', 'paisay', 'paise', 'jana', 'ticket',
    'kab', 'kahan', 'apka', 'aap', 'kr', 'do', 'kar', 'ho', 'ga', 'gi', 'gy', 'tha',
    'thi', 'aur', 'or', 'mein', 'ma', 'main', 'sy', 'se', 'ko', 'ka', 'ki', 'ke',
    'bhejo', 'bhej', 'dikhao', 'acha', 'theek', 'thik', 'nahi', 'nai', 'haan', 'han',
    'ji', 'jee', 'shukriya', 'meharbani', 'masla', 'tarika', 'tariqa', 'shadi', 'pyar'
  ]);

  const romanMatches = words.filter(w => romanUrduVocab.has(w)).length;
  if (romanMatches >= 2 || (words.length <= 3 && romanMatches >= 1)) {
    return 'ROMAN_URDU (رومن اردو — Reply strictly in Roman Urdu using English alphabets, e.g. "Jee Sir, main aapko guide karta hoon...")';
  }

  return 'PURE_ENGLISH (Reply strictly in natural, fluent English — DO NOT mix Roman Urdu or Urdu script!)';
}

// Dual Sessions:
// - wa2 (0343-4762264): Official Business Number (100% Automatic Ali Ahmad AI for all incoming clients)
// - wa1 (0325-7938125): CEO Personal Number (Gatekeeper Mode: NEVER auto-replies unless CEO clicks/selects "Client"!)
const sessions = {
  wa1: {
    id: 'wa1',
    label: 'Personal Number: 0325-7938125 (Smart Gatekeeper: Ask Personal vs Client)',
    authDir: './wa_auth_info',
    sock: null,
    qr: null,
    status: 'Initializing...',
    user: null
  },
  wa2: {
    id: 'wa2',
    label: 'Official Business Number: 0343-4762264 (100% Auto-Reply: Ali Ahmad)',
    authDir: './wa_auth_info_2',
    sock: null,
    qr: null,
    status: 'Initializing...',
    user: null
  }
};

let recentLogs = [];
const repliedCooldown = new Map();
let lastCallerPendingPermission = null;
const processedCallIds = new Set();
const conflictCount = { wa1: 0, wa2: 0 };
let cloudStandbyMode = false;

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${maskSensitiveLog(msg)}`;
  console.log(line);
  recentLogs.unshift(line);
  if (recentLogs.length > 60) recentLogs.pop();
}

function getAvailableMediaCatalog() {
  const catalog = [];
  const allowedExts = new Set(['.png', '.jpg', '.jpeg', '.pdf']);
  const seenPaths = new Set();

  // 1. Scan ONLY official poster directories (AL-BAHR_All_24_Umrah_Posters & ./posters)
  for (const dir of OFFICIAL_POSTER_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (seenPaths.has(fullPath)) continue;
        const ext = path.extname(file).toLowerCase();
        if (!allowedExts.has(ext)) continue;
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        seenPaths.add(fullPath);
        catalog.push({
          name: file,
          path: fullPath,
          ext,
          type: ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : 'document',
          sizeKB: Math.round(stat.size / 1024)
        });
      }
    } catch (e) {}
  }

  // 2. Add ONLY explicitly whitelisted Al-Bahr travel/visa files from Downloads (never scan random personal files!)
  for (const fullPath of WHITELISTED_TRAVEL_FILES) {
    if (!fs.existsSync(fullPath) || seenPaths.has(fullPath)) continue;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      const file = path.basename(fullPath);
      const ext = path.extname(file).toLowerCase();
      seenPaths.add(fullPath);
      catalog.push({
        name: file,
        path: fullPath,
        ext,
        type: ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : 'document',
        sizeKB: Math.round(stat.size / 1024)
      });
    } catch (e) {}
  }

  return catalog;
}

// Automatically generate an official Al-Bahr Branded Poster on the backend if no existing poster matches the client's specific visa/country query!
async function findOrGenerateTravelMedia(keywordQuery) {
  const q = (keywordQuery || '').toLowerCase();

  // Check if they asked for a specific non-Umrah visa poster (both English & Urdu keywords!)
  const needsCustomVisaPoster = /\b(schengen|europe|greece|greek|uk|london|england|usa|america|turkey|istanbul|study|student|scholarship|germany|italy|hungary|china|korea|medical|gamca|wafid|token|iqama|akama|kama|work|kafeel|poland|albania|dubai|uae|qatar|malaysia|thailand|visit)\b|شینگن|شنگن|یورپ|گریس|گریز|یونان|یو کے|امریکہ|ترکی|سٹڈی|میڈیکل|گیمکا|وافد|اقامہ|اقامے|ورک|کفیل|وکالہ|وزٹ|دبئی|قطر/i.test(q);

  if (needsCustomVisaPoster) {
    try {
      const postersDir = path.join(__dirname, 'posters');
      const { stdout } = await execFileAsync('python3', [GENERATE_POSTER_SCRIPT, keywordQuery, postersDir], { timeout: 10000 });
      const generatedPath = (stdout || '').trim();
      if (generatedPath && fs.existsSync(generatedPath)) {
        const stat = fs.statSync(generatedPath);
        const file = path.basename(generatedPath);
        addLog(`🎨 [Auto-Poster Matched/Generated] ${file}`);
        return {
          name: file,
          path: generatedPath,
          ext: '.png',
          type: 'image',
          sizeKB: Math.round(stat.size / 1024)
        };
      }
    } catch (err) {
      addLog(`[Auto-Poster Generator Error] ${err.message}`);
    }
  }

  const existing = findMediaByKeyword(keywordQuery);
  if (existing) return existing;

  try {
    const postersDir = path.join(__dirname, 'posters');
    const { stdout } = await execFileAsync('python3', [GENERATE_POSTER_SCRIPT, keywordQuery, postersDir], { timeout: 10000 });
    const generatedPath = (stdout || '').trim();
    if (generatedPath && fs.existsSync(generatedPath)) {
      const stat = fs.statSync(generatedPath);
      const file = path.basename(generatedPath);
      return {
        name: file,
        path: generatedPath,
        ext: '.png',
        type: 'image',
        sizeKB: Math.round(stat.size / 1024)
      };
    }
  } catch (e) {}

  return null;
}

function findMediaByKeyword(keywordQuery) {
  if (!keywordQuery) return null;
  const catalog = getAvailableMediaCatalog();
  const q = keywordQuery.toLowerCase().trim();
  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of catalog) {
    const lowerName = item.name.toLowerCase();
    let score = 0;
    if (lowerName === q) score += 100;
    for (const tok of tokens) {
      if (tok.length < 2 && !/[0-9]/.test(tok)) continue;
      if (lowerName.includes(tok)) {
        score += /[0-9]+/.test(tok) ? 25 : 10;
      }
    }
    if ((q.includes('poster') || q.includes('image') || q.includes('photo') || q.includes('pic')) && item.type === 'image') {
      score += 8;
    }
    if ((q.includes('pdf') || q.includes('file') || q.includes('document') || q.includes('list') || q.includes('demand')) && item.type === 'document') {
      score += 8;
    }
    if ((q.includes('umrah') || q.includes('package')) && lowerName.includes('umrah_group_01')) {
      score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }
  return bestScore >= 8 ? bestMatch : null;
}

async function searchWebForTravelInfo(query) {
  const results = [];
  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddgRes = await fetch(ddgUrl, { signal: AbortSignal.timeout(3500) });
    if (ddgRes.ok) {
      const data = await ddgRes.json();
      if (data.AbstractText) results.push(data.AbstractText);
    }
  } catch (e) {}

  try {
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' Pakistan visa travel requirements')}`;
    const htmlRes = await fetch(htmlUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(4500)
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const snippetMatches = [...html.matchAll(/class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const m of snippetMatches.slice(0, 4)) {
        const clean = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (clean) results.push(clean);
      }
    }
  } catch (e) {}

  return results.join('\n- ');
}

function buildAliAhmadSystemPrompt(clientRecord, honorific, detectedLanguage, isOngoingChat, isVoiceMessage, mediaCatalogSummary) {
  return `You are *Ali Ahmad*, Senior Travel & Visa Marketing Consultant at *AL-BAHR HORIZON TRAVELS & CONSULTANTS (Lahore)* (Website: www.albahrtravels.com | Office: 78 E Block, Architect Engineering Housing Society, Lahore | Official WhatsApp: 0343-4762264 | Company CEO & Owner: Sir Mubashir Ali | SECP Registered Private Limited Company).

OFFICIAL AL-BAHR PACKAGES, EXACT PRICES & REQUIRED DOCUMENTS KNOWLEDGE BASE (MEMORIZE THIS!):
1. **EXACT UMRAH PACKAGES & PRICES (FROM LAHORE TO JEDDAH):**
   - **Economy / Shuttle Umrah Packages (20 Nights — 12 Nights Makkah + 8 Nights Madinah):**
     - *November / December Economy Group (Fly Jinnah / PIA / Saudia):*
       - **Sharing Room:** PKR 267,000 to PKR 273,000 (دو لاکھ سڑسٹھ ہزار سے دو لاکھ تہتر ہزار روپے)
       - **Quad Room (4 Beds):** PKR 273,000 to PKR 280,000 (دو لاکھ تہتر ہزار سے دو لاکھ اسی ہزار روپے)
       - **Triple Room (3 Beds):** PKR 282,000 to PKR 290,000 (دو لاکھ بیاسی ہزار سے دو لاکھ نوے ہزار روپے)
       - **Double Room (2 Beds):** PKR 301,000 to PKR 311,000 (تین لاکھ ایک ہزار سے تین لاکھ گیارہ ہزار روپے)
       - *Hotels:* Rawafed Al Asmiah Shuttle Hotel Makkah + Manazil Al Marjhaan Al Madina (1000m).
   - **Near-Haram / 500-Meter Walking Distance Umrah Packages (14 Nights & 20 Nights — Saudia / Fly Jinnah / PIA):**
     - *14 Nights Near-Haram (PKG #757 / #758 / #801 — 8 Nights Makkah + 6 Nights Madinah):*
       - **Sharing:** PKR 293,000 to PKR 320,000 (دو لاکھ ترانوے ہزار سے تین لاکھ بیس ہزار روپے)
       - **Quad:** PKR 303,000 to PKR 337,000 | **Triple:** PKR 320,000 to PKR 365,000 | **Double:** PKR 354,000 to PKR 420,000
       - *Hotels:* Mathar Al Jewar / Al Juhani Ajyad Makkah (500m) + Arjwan Al Madinah / Markazia (250-300m).
   - **Umrah Visa Only / Custom Package Range:** Starts around PKR 210,000 – PKR 225,000 (دو لاکھ دس ہزار سے دو لاکھ پچیس ہزار روپے) for budget economy depending on airline and hotel category.
   - **HOW TO SPEAK PRICES:** NEVER say individual digits like "2, 4, 6, 8"! Always state the exact real price clearly in thousands/lakhs (e.g., *"دو لاکھ پچیس ہزار روپے"*, *"دو لاکھ دس ہزار روپے"*, *"دو لاکھ تہتر ہزار روپے"*).

2. **EXACT REQUIRED DOCUMENTS BY SERVICE (NEVER SAY "SNAPCHAT" OR "SNAPSHOT" — ALWAYS ASK FOR PROPER DOCUMENTS!):**
   - **For Umrah Visa & Package Booking:**
     1. **پاسپورٹ کی واضح تصویر** (Original Passport first page clear picture — minimum 6 to 8 months validity)
     2. **قومی شناختی کارڈ کی تصویر** (Valid CNIC front & back clear picture)
     3. **ایک عدد پاسپورٹ سائز تصویر سفید یا نیلے بیک گراؤنڈ کے ساتھ** (1 Fresh Passport-size photograph with white/blue background)
   - **For Saudi Work Visa / Iqama / Employment Visa:**
     1. **پاسپورٹ کی واضح تصویر** (Original Passport clear picture)
     2. **شناختی کارڈ کی تصویر** (CNIC clear picture)
     3. **وائٹ بیک گراؤنڈ والی پاسپورٹ سائز تصویر** (Passport size photo with white background)
     4. **تعلیمی اسناد یا ڈپلومہ / تجربہ سرٹیفکیٹ** (Educational Degree/Diploma & CV for skilled/professional visas)
     5. **اگر پہلے کوئی ویزا لگا ہے تو اس ویزے کی تصویر** (Clear picture of previous visa if applicable)
   - **For Visit Visa (Schengen / Europe / UK / USA / Turkey / Gulf):**
     1. **پاسپورٹ کی تصویر** (Passport picture) + **شناختی کارڈ کی تصویر** (CNIC picture) + **پاسپورٹ سائز تصویر** (White background photo)
     2. **بینک سٹیٹمنٹ اور اکاؤنٹ مینٹیننس سرٹیفکیٹ** (Last 6 months Bank Statement) + **این ٹی این / جاب لیٹر یا بزنس پروف** (FRC, NTN / Job Salary Slips).

3. **DO NOT ASK FOR DOCUMENTS IN EVERY MESSAGE (CRITICAL!):**
   - NEVER ask for Passport, CNIC, or Photos in every reply!
   - When a client is asking general questions, asking about prices, asking how a process works, or asking for a poster, ONLY answer their question warmly and naturally.
   - Ask for documents **ONLY** when the client explicitly says they are ready to book/apply (e.g., *"Mera book kar dein"*, *"Apply kaise karna hai?"*, *"Kaun se documents chahiye?"*, *"Done karein"*).

4. **NATURAL HUMAN SPOKEN URDU & ENGLISH SYNTAX (NO SLASHES, NO BULLET LISTS, NO ROBOTIC ESSAYS!):**
   - You are talking on WhatsApp like a real human consultant sitting in Lahore!
   - **CRITICAL FORMATTING RULE:**
     - **NEVER use slashes (\`/\`)**, colons (\`:\`), markdown headings (\`---\`, \`**\`), brackets \`(...)\`, or bullet lists (\`-\`) in your reply! Instead of writing *"ویزہ سینٹر (VFS Global / Gerry's / BLS)"*, say naturally in plain spoken words: *"وی ایف ایس گلوبل یا جیریز ویزا سینٹر"*.
     - **NEVER write long essays!** Keep your entire reply **short, warm, and conversational (3 to 4 sentences maximum)**.
     - **HOW TO EXPLAIN A PROCESS (طریقہ کار):** When you fetch info from Google/Web or explain a visa/appointment procedure (like Greece Schengen appointment or Saudi Iqama), explain the practical **step-by-step method (طریقہ کار)** in simple, easy-to-understand spoken language so the client immediately understands *how* it works (e.g., *"جی سر، گریس کے شینگن ویزے کا طریقہ کار بہت سادہ ہے، اس کی اپوائنٹمنٹ وی ایف ایس گلوبل کے پورٹل سے آن لائن بُک ہوتی ہے۔ پہلے ہم آپ کا آن لائن ویزا فارم بھر کر اپوائنٹمنٹ کی سلاٹ بُک کرتے ہیں، جو عام طور پر دو سے تین ہفتے کی ملتی ہے، اور پھر آپ لاہور سینٹر جا کر اپنی فائل اور بائیو میٹرکس جمع کرواتے ہیں۔ میں نے آپ کو شینگن ویزے کا پوسٹر بھی بھیج دیا ہے، آپ بتائیں آپ نے کس مہینے سفر کرنا ہے تاکہ میں ابھی سلاٹ چیک کر لوں؟"*).
     - **IF CLIENT SPEAKS ENGLISH:** Reply in 100% fluent, natural, conversational English with zero slashes or robotic symbols.
   - Ongoing chat? **${isOngoingChat ? 'YES — DO NOT say Assalam-o-Alaikum, Walaikum Assalam, or Hello, and do NOT re-introduce yourself!' : 'NO (First message) — Greet respectfully once.'}**
   - Address this client (**${clientRecord.name}**, **${honorific.gender}**) respectfully as **"${honorific.enHonorific}"** / **"${honorific.urHonorific}"**.
   - Match the client's exact language (**${detectedLanguage}**).

5. **WORLD-CLASS MARKETING ETHICS & HEART-WINNING PERSUASION (TAAKE CLIENT HATH SE NA JAYE):**
   - Talk with genuine warmth, honesty, affection (*piyar aur muhabbat*), and rock-solid professionalism so the client feels: *"Yar kaam karwana hai to sirf Al-Bahr Travels se hi karwana hai!"*

6. **POSTER & FILE AUTO-DELIVERY:**
   - Available Posters & PDF Files:
     ${mediaCatalogSummary}
   - If the client asks for a poster or file, set \`"sendFile"\` in the JSON tag below (and NEVER type the filename like \`.png\` inside your message!).

7. **REQUIRED JSON TAG AT THE VERY END (KEEP IT SHORT SO IT NEVER TRUNCATES):**
   - On a new line at the very end, output:
     \`[[ALI_ACTION:{"summary":"1-line summary","sendFile":"filename_or_empty"}]]\``;
}

function generateContextAwareIntelligentReply(clientRecord, honorific, detectedLanguage, isOngoingChat, incomingText, matchedMedia) {
  const lower = incomingText.toLowerCase();
  const isUrduScript = detectedLanguage.startsWith('URDU_SCRIPT');
  const isRomanUrdu = detectedLanguage.startsWith('ROMAN_URDU');
  const titleEn = honorific.enHonorific;
  const titleUr = honorific.gender === 'Female' ? 'محترمہ' : 'سر';
  const askedForDocs = /\b(document|documents|kaghaz|kaaghaz|paper|apply|book|done)\b|ڈاکومنٹ|کاغذات|بکنگ|اپلائی/i.test(lower);

  if (/kaun|kon|who are you|owner|ceo|malik|کون|اونر|مالک/i.test(lower)) {
    if (isUrduScript || isRomanUrdu) {
      return `جی ${titleUr}، میں علی احمد بات کر رہا ہوں، ال بحر، ہورائزن ٹریولز اینڈ کنسلٹنٹس، لاہور سے۔ میں یہاں سینئر ویزا کنسلٹنٹ ہوں اور ہماری کمپنی کے سی ای او اور اونر سر مبشر علی ہیں۔ آپ بے فکر ہو کر بتائیں میں آپ کی کیا رہنمائی کر سکتا ہوں؟`;
    }
    return `Certainly ${titleEn}, I am Ali Ahmad, Senior Visa & Travel Consultant at Al Bahr Horizon Travels and Consultants, Lahore, working with our CEO Sir Mubashir Ali. Please tell me how I can help you today!`;
  }

  if (/ticket|flight|air|fare|booking|seat|ٹکٹ|فلائٹ|بکنگ|سیٹ/i.test(lower)) {
    if (isUrduScript || isRomanUrdu) {
      return `جی بالکل ${titleUr}، فلائٹ اور ٹکٹ بکنگ کے لیے مجھے بتائیں کہ آپ نے کس شہر سے کہاں کا سفر کرنا ہے اور کس تاریخ کی فلائٹ چاہیے؟ میں ابھی آپ کو سب سے سستا اور بہترین ریٹ چیک کر کے بتاتا ہوں۔`;
    }
    return `Certainly ${titleEn}! For flight and ticket booking, please tell me your departure city, destination, and travel date so I can check the best live fare for you right away.`;
  }

  if (/umrah|package|december|november|group|price|kharcha|عمرہ|پیکج|دسمبر|نومبر/i.test(lower)) {
    if (isUrduScript || isRomanUrdu) {
      const base = `جی ${titleUr}، ہمارے پاس لاہور سے عمرہ کا اکانومی پیکج دو لاکھ دس ہزار روپے سے دو لاکھ پچیس ہزار روپے میں شروع ہوتا ہے، اور بیس دن کا مکمل گروپ پیکج دو لاکھ چوہتر ہزار روپے کا ہے جس میں ٹکٹ، ویزا، مکہ مکرمہ اور مدینہ منورہ ہوٹل شامل ہیں۔ آپ بتائیں آپ کتنے دن کا پیکج چاہتے ہیں اور کس مہینے جانے کا ارادہ ہے؟`;
      return askedForDocs
        ? `${base} بکنگ کے لیے بس پاسپورٹ، شناختی کارڈ اور ایک پاسپورٹ سائز تصویر درکار ہوتی ہے۔`
        : base;
    }
    return `Certainly ${titleEn}! Our budget Economy Umrah Package starts from PKR 210,000 to PKR 225,000, and our 20-Nights Group Package with direct flight, visa, and Makkah/Madinah hotels is PKR 274,000. Which month and duration are you planning for?`;
  }

  if (/iqama|work|kafeel|wakala|اقامہ|ورک|کفیل/i.test(lower)) {
    if (isUrduScript || isRomanUrdu) {
      const base = `جی ${titleUr}، سعودی عرب کا اقامہ ورک ویزا کے ذریعے بنتا ہے۔ اس میں سعودی کفیل یا کمپنی سے وکالہ اور ای نمبر نکلوا کر لاہور سے گیمکا میڈیکل اور اعتماد بائیو میٹرکس کروائے جاتے ہیں، اور سعودی عرب پہنچتے ہی آپ کا قانونی اقامہ کارڈ بن جاتا ہے۔ آپ کس فیلڈ یا کام کے ویزے میں جانا چاہتے ہیں؟`;
      return askedForDocs
        ? `${base} جب آپ اپلائی کرنا چاہیں تو پاسپورٹ، شناختی کارڈ اور تصویر بھیج کر فائل شروع کروا سکتے ہیں۔`
        : base;
    }
  }

  if (matchedMedia && /poster|photo|pic|image|file|pdf|demand|send|bhej|dikha/i.test(lower)) {
    if (isUrduScript || isRomanUrdu) {
      return `جی بالکل ${titleUr}، میں نے آپ کو پوسٹر بھیج دیا ہے، آپ تسلی سے دیکھ لیں۔ اس کے بارے میں کوئی بھی سوال ہو تو مجھے بتائیں۔`;
    }
    return `Certainly ${titleEn}, I have just sent you the poster. Please take a look and let me know if you have any questions about it!`;
  }

  if (isUrduScript || isRomanUrdu) {
    return `جی بالکل ${titleUr}، میں آپ کی بات سمجھ گیا ہوں۔ آپ مجھے بتائیں کہ اس سلسلے میں آپ کو مزید کیا تفصیل چاہیے، میں آپ کو مکمل گائیڈ کرتا ہوں۔`;
  }
  return `Certainly ${titleEn}, I completely understand. Please let me know what specific details you would like to check next and I will guide you right away!`;
}

async function transcribeWhatsAppAudio(sock, msg) {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const downloadMediaMessage = baileys.downloadMediaMessage;
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );
    const tmpOgg = path.join(os.tmpdir(), `wa_voice_in_${Date.now()}.ogg`);
    fs.writeFileSync(tmpOgg, buffer);
    try {
      const { stdout } = await execFileAsync('python3', [TRANSCRIBE_SCRIPT, tmpOgg], { timeout: 20000 });
      fs.unlinkSync(tmpOgg);
      return (stdout || '').trim();
    } catch (e) {
      if (fs.existsSync(tmpOgg)) fs.unlinkSync(tmpOgg);
      addLog(`[Voice Transcribe Error] ${e.message}`);
      return '';
    }
  } catch (err) {
    addLog(`[Voice Download Error] ${err.message}`);
    return '';
  }
}

function normalizeJid(to) {
  let jid = to.replace(/^whatsapp:/i, '').trim();
  if (!jid.includes('@s.whatsapp.net') && !jid.includes('@g.us') && !jid.includes('@lid')) {
    let digits = jid.replace(/[^0-9]/g, '');
    if (digits.startsWith('03') && digits.length === 11) {
      digits = '92' + digits.slice(1);
    }
    jid = digits + '@s.whatsapp.net';
  }
  return jid;
}

function getSockForSession(sessionKey = 'wa2') {
  const s = sessions[sessionKey];
  if (s && s.status === 'Connected' && s.sock) return s.sock;
  if (sessions.wa2.status === 'Connected' && sessions.wa2.sock) return sessions.wa2.sock;
  if (sessions.wa1.status === 'Connected' && sessions.wa1.sock) return sessions.wa1.sock;
  throw new Error(`WhatsApp session ${sessionKey} is not connected.`);
}

async function sendWhatsAppMessage(to, message, sessionKey = 'wa2') {
  const jid = normalizeJid(to);
  const sock = getSockForSession(sessionKey);
  await sock.sendMessage(jid, { text: message });
  addLog(`[Ali Ahmad (${sessionKey.toUpperCase()}) -> ${jid.replace('@s.whatsapp.net', '')}] "${message.substring(0, 80).replace(/\n/g, ' ')}..."`);
}

async function sendAliAhmadVoiceNote(to, textToSpeak, langMode = 'URDU_SCRIPT', sessionKey = 'wa2') {
  const jid = normalizeJid(to);
  const sock = getSockForSession(sessionKey);
  const tmpOutOgg = path.join(os.tmpdir(), `ali_voice_out_${Date.now()}.ogg`);
  try {
    try {
      await sock.sendPresenceUpdate('recording', jid);
    } catch (e) {}

    await execFileAsync('python3', [GENERATE_VOICE_SCRIPT, textToSpeak, langMode, tmpOutOgg], { timeout: 25000 });
    const audioBuffer = fs.readFileSync(tmpOutOgg);
    await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });
    fs.unlinkSync(tmpOutOgg);
    addLog(`[Ali Ahmad (${sessionKey.toUpperCase()}) Sent Voice Note 🎤 -> ${jid.replace('@s.whatsapp.net', '')}] "${textToSpeak.substring(0, 70).replace(/\n/g, ' ')}..."`);
  } catch (err) {
    if (fs.existsSync(tmpOutOgg)) fs.unlinkSync(tmpOutOgg);
    addLog(`[Voice Note Send Error] ${err.message}`);
  }
}

async function sendWhatsAppMedia(to, mediaItem, caption, sessionKey = 'wa2') {
  const jid = normalizeJid(to);
  const sock = getSockForSession(sessionKey);
  const buffer = fs.readFileSync(mediaItem.path);
  if (mediaItem.type === 'image') {
    await sock.sendMessage(jid, {
      image: buffer,
      caption: caption || mediaItem.name
    });
  } else {
    const mimeMap = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.apk': 'application/vnd.android.package-archive'
    };
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mimeMap[mediaItem.ext] || 'application/octet-stream',
      fileName: mediaItem.name,
      caption: caption || mediaItem.name
    });
  }
  addLog(`[Ali Ahmad (${sessionKey.toUpperCase()}) Sent Media -> ${jid.replace('@s.whatsapp.net', '')}] 📎 ${mediaItem.name}`);
}

async function handleIncomingWhatsAppCall(sessionKey, callEvent) {
  // Never interfere with personal calls on 0325 unless that caller is explicitly marked as 'client'!
  if (sessionKey === 'wa1') {
    const callerStatus = personal0325Contacts[callEvent.from]?.mode;
    if (callerStatus !== 'client') return;
  }

  const callId = callEvent.id;
  const callerJid = callEvent.from;
  const status = callEvent.status;

  if (status !== 'offer' && status !== 'ringing') return;
  if (processedCallIds.has(callId)) return;
  processedCallIds.add(callId);

  const clientRecord = clientMemoryDB[callerJid] || {};
  const callerName = clientRecord.name || callerJid.replace('@s.whatsapp.net', '').replace('@lid', '');
  const honorific = guessHonorificFromName(callerName);

  addLog(`📞 [INCOMING CALL on ${sessionKey.toUpperCase()}] From ${callerName} (${callerJid}) — Asking CEO (0325-7938125) for permission...`);

  if (lastCallerPendingPermission?.timer) {
    clearTimeout(lastCallerPendingPermission.timer);
  }

  const autoTimer = setTimeout(async () => {
    if (lastCallerPendingPermission && lastCallerPendingPermission.callId === callId && !lastCallerPendingPermission.handled) {
      lastCallerPendingPermission.handled = true;
      addLog(`📞 [Call Auto-Assist] 25s passed without CEO manual pickup -> Ali Ahmad is now talking to ${callerName} via Voice Note!`);
      await engageCallerWithAliAhmadVoice(callerJid, callerName, honorific, sessionKey);
    }
  }, 25000);

  lastCallerPendingPermission = {
    callId,
    callerJid,
    callerName,
    honorific,
    sessionKey,
    timestamp: Date.now(),
    handled: false,
    timer: autoTimer
  };

  const permissionMsg =
    `📞 *INCOMING WHATSAPP CALL*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Caller:* ${callerName} (${honorific.enHonorific})\n` +
    `📱 *Caller ID:* ${callerJid.replace('@s.whatsapp.net', '')}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `❓ *Boss, is client se main (Ali Ahmad) apni awaaz mein baat karoon ya aap khud call pick karenge?*\n` +
    `👉 Reply *"Call 1"* — Ali Ahmad Voice Note 🎤 mein baat kare.\n` +
    `👉 Reply *"Call 2"* — Aap khud baat karenge.`;

  try {
    await sendWhatsAppMessage(CEO_PERSONAL_NUMBER, permissionMsg, 'wa2');
  } catch (err) {
    addLog(`[Call Alert Error] ${err.message}`);
  }
}

async function engageCallerWithAliAhmadVoice(callerJid, callerName, honorific, sessionKey = 'wa2') {
  const clientRecord = clientMemoryDB[callerJid];
  const lastMsg = clientRecord?.messages?.slice(-1)?.[0]?.content || '';
  const langMode = lastMsg ? detectExactClientLanguage(lastMsg) : 'URDU_SCRIPT';
  const titleUr = honorific.gender === 'Female' ? 'محترمہ' : 'سر';
  const titleEn = honorific.enHonorific;
  const baseUrl = getLiveCallBaseUrl();
  const liveCallUrl = `${baseUrl}/call?jid=${encodeURIComponent(callerJid)}&name=${encodeURIComponent(callerName)}`;

  let voiceSpeech = '';
  let callLinkMsg = '';
  if (langMode.startsWith('PURE_ENGLISH')) {
    voiceSpeech = `Hello ${titleEn}, this is Ali Ahmad speaking from Al Bahr Horizon Travels and Consultants, Lahore. I have opened our live voice call line for you right now. Just tap the live call link I sent you above to talk to me live in real time, or reply with a voice note right here!`;
    callLinkMsg = `📞 *AL-BAHR TRAVELS — LIVE AI VOICE CALL WITH ALI AHMAD*\n━━━━━━━━━━━━━━━━━━\n${titleEn}, tap this link to talk to *Ali Ahmad* on a **Live Real-Time Voice Call** right now:\n👉 ${liveCallUrl}`;
  } else {
    voiceSpeech = `السلام علیکم ${titleUr}، میں علی احمد بات کر رہا ہوں، ال بحر، ہورائزن ٹریولز اینڈ کنسلٹنٹس، لاہور سے۔ ابھی آپ کی واٹس ایپ کال آئی ہے، میں نے آپ کے لیے لائیو کال لائن آن کر دی ہے، اوپر دیے گئے لائیو کال لنک پر کلک کر کے آپ ابھی مجھ سے براہ راست لائیو کال پر بات کر سکتے ہیں، یا یہیں وائس نوٹ بھیج سکتے ہیں۔`;
    callLinkMsg = `📞 *ال بحر ٹریولز — علی احمد کے ساتھ لائیو وائس کال*\n━━━━━━━━━━━━━━━━━━\nمحترم ${titleUr}، علی احمد سے ابھی **براہِ راست لائیو کال (Live Real-Time Voice Call)** پر بات کرنے کے لیے نیچے دیے گئے لنک پر کلک کریں:\n👉 ${liveCallUrl}`;
  }

  try {
    // Reject the ringing WhatsApp call cleanly and immediately send the 1-Tap Live Voice Call Room link + Voice Note!
    await sendWhatsAppMessage(callerJid, callLinkMsg, sessionKey);
    await sendAliAhmadVoiceNote(callerJid, voiceSpeech, langMode.startsWith('PURE_ENGLISH') ? 'PURE_ENGLISH' : 'URDU_SCRIPT', sessionKey);
  } catch (e) {
    addLog(`[Engage Caller Error] ${e.message}`);
  }
}

async function generateAliAhmadReply(clientJid, clientName, clientPhone, incomingText, isVoiceMessage = false) {
  let clientRecord = clientMemoryDB[clientJid];
  if (!clientRecord && clientPhone) {
    const existingKey = Object.keys(clientMemoryDB).find(k => clientMemoryDB[k].phone === clientPhone);
    if (existingKey) clientRecord = clientMemoryDB[existingKey];
  }
  if (!clientRecord) {
    clientRecord = {
      name: clientName || 'Valued Client',
      phone: clientPhone || clientJid,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      notes: '',
      messages: []
    };
    clientMemoryDB[clientJid] = clientRecord;
  }

  if (clientName && clientName !== 'Client' && clientName !== 'Valued Client') {
    clientRecord.name = clientName;
  }
  if (clientPhone && !clientPhone.includes('@lid')) {
    clientRecord.phone = clientPhone;
  }
  clientRecord.lastSeen = new Date().toISOString();

  const isOngoingChat = clientRecord.messages.length > 0;
  const honorific = guessHonorificFromName(clientRecord.name);
  const detectedLanguage = detectExactClientLanguage(incomingText);

  const isAskingForMedia = /\b(poster|posters|photo|photos|pic|picture|image|flyer|brochure|pdf|file|document|demand|package|packages|پوسٹر|فائل|تصویر|پیکج)\b/i.test(incomingText);
  let preMatchedMedia = isAskingForMedia ? findMediaByKeyword(incomingText) : null;

  const catalog = getAvailableMediaCatalog();
  const catalogSummary = catalog
    .slice(0, 35)
    .map(c => `- "${c.name}" (${c.type}, ${c.sizeKB}KB)`)
    .join('\n     ');

  let webFacts = '';
  if (incomingText.trim().length > 10 && !/^(hi|hello|salam|assalam|aoa|ok|okay|thanks|shukriya)$/i.test(incomingText.trim())) {
    webFacts = await searchWebForTravelInfo(incomingText);
  }

  const userTurnLabel = isVoiceMessage
    ? `Client (${clientRecord.name} - ${honorific.enHonorific}) [SENT A VOICE NOTE]: "${incomingText}"`
    : `Client (${clientRecord.name} - ${honorific.enHonorific}): ${incomingText}`;

  clientRecord.messages.push({
    role: 'user',
    content: webFacts
      ? `${userTurnLabel}\n\n[Live Web Search Info: ${webFacts}]`
      : userTurnLabel
  });

  if (clientRecord.messages.length > 24) {
    clientRecord.messages = clientRecord.messages.slice(-24);
  }

  // Use ONLY top-tier fluent Urdu/English models (NEVER use openrouter/free because it routes to small 30B nano models that write broken gibberish Urdu!)
  const modelsToTry = [
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'baidu/ernie-5.5-flash-preview:free',
    'google/gemma-4-26b-a4b-it:free',
    'recursive/flint-v1.0:free'
  ];

  let rawReply = '';
  const systemPrompt = buildAliAhmadSystemPrompt(
    clientRecord,
    honorific,
    detectedLanguage,
    isOngoingChat,
    isVoiceMessage,
    catalogSummary
  );

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.albahrtravels.com',
          'X-Title': 'Al-Bahr Horizon Travels AI Agent Ali Ahmad'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...clientRecord.messages
          ],
          temperature: 0.65,
          max_tokens: 1400,
          reasoning: { exclude: true }
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (res.ok) {
        const textBody = await res.text();
        const data = JSON.parse(textBody.trim());
        const content = (data.choices?.[0]?.message?.content || '').trim();
        if (content && !content.startsWith("Here's a thinking process")) {
          rawReply = content;
          addLog(`[AI Ali Ahmad] Responded via ${data.model || model} (${honorific.enHonorific} | ${detectedLanguage.split(' ')[0]})`);
          break;
        }
      } else {
        await new Promise(r => setTimeout(r, 700));
      }
    } catch (err) {
      addLog(`[AI Ali Ahmad] Attempt ${i + 1} (${model}) error: ${err.message}`);
    }
  }

  let actionData = {
    summary: '',
    updatedClientNotes: clientRecord.notes,
    sendFile: ''
  };
  let cleanReply = rawReply;

  if (rawReply) {
    // Match even if the closing ]] was truncated by token limits!
    const match = rawReply.match(/\[\[(?:ALI_ACTION|LEAD_STATUS):([\s\S]*?)(?:\]\]|$)/);
    if (match) {
      cleanReply = rawReply.replace(match[0], '').trim();
      try {
        const jsonStr = match[1].trim().endsWith('}') ? match[1].trim() : match[1].trim() + '"}';
        const parsed = JSON.parse(jsonStr);
        actionData = { ...actionData, ...parsed };
      } catch (e) {
        const fileMatch = match[1].match(/"sendFile"\s*:\s*"([^"]+)"/);
        if (fileMatch) actionData.sendFile = fileMatch[1];
      }
    }

    // Clean any slashes, filenames, or weird non-Urdu/non-English characters from cleanReply
    cleanReply = cleanReply
      .replace(/\bAlBahr_[A-Za-z0-9_]+\.(png|pdf|jpg)\b/gi, '')
      .replace(/\(\s*\)/g, '')
      .trim();

    if (isOngoingChat && !/\b(salam|assalam|aoa|hello|hi|hey)\b|سلام/i.test(incomingText)) {
      cleanReply = cleanReply
        .replace(/^(wa\s*alaikum\s*assalam|walaikum\s*assalam|assalam[- ]o[- ]alaikum|hello|hi|hey|وعلیکم السلام|السلام علیکم)[^!\n.]*[!\n.]\s*/i, '')
        .replace(/^(i['’]?m|this is|main)\s+\*?ali ahmad\*?\s+from\s+\*?al-bahr[^.\n]*[.\n]\s*/i, '')
        .trim();
    }
  } else {
    cleanReply = generateContextAwareIntelligentReply(
      clientRecord,
      honorific,
      detectedLanguage,
      isOngoingChat,
      incomingText,
      preMatchedMedia
    );
    if (preMatchedMedia) actionData.sendFile = preMatchedMedia.name;
  }

  if (actionData.updatedClientNotes) {
    clientRecord.notes = actionData.updatedClientNotes;
  } else {
    clientRecord.notes = `${clientRecord.notes ? clientRecord.notes + ' | ' : ''}${incomingText.substring(0, 120)}`.slice(-600);
  }
  clientRecord.messages.push({ role: 'assistant', content: cleanReply });
  saveClientMemory();

  let mediaToSend = null;
  if (isAskingForMedia) {
    mediaToSend = await findOrGenerateTravelMedia(incomingText);
  } else if (actionData.sendFile) {
    mediaToSend = await findOrGenerateTravelMedia(actionData.sendFile);
  }

  return {
    replyText: cleanReply,
    leadStatus: actionData,
    mediaToSend,
    honorific: honorific.enHonorific,
    detectedLanguage: detectedLanguage.split(' ')[0],
    historyCount: clientRecord.messages.length,
    savedNotes: clientRecord.notes
  };
}

// Anti-Ban Human Simulation Helper: Realistic delay + Read Receipt + Typing/Recording Presence
async function simulateHumanPresenceBeforeReply(sock, jid, msgKey, isVoice = false, textLength = 60) {
  if (!sock) return;
  try {
    // 1. Wait 1.2 - 2.2 seconds before marking message as read (just like a real person picking up their phone)
    const readDelay = 1200 + Math.floor(Math.random() * 1000);
    await new Promise(r => setTimeout(r, readDelay));
    if (msgKey) {
      await sock.readMessages([msgKey]).catch(() => {});
    }
    // 2. Show composing / recording presence for a natural 2.0 - 4.2 seconds with random jitter
    await sock.sendPresenceUpdate(isVoice ? 'recording' : 'composing', jid).catch(() => {});
    const typeDelay = Math.min(4500, Math.max(2000, textLength * 18 + Math.floor(Math.random() * 1200)));
    await new Promise(r => setTimeout(r, typeDelay));
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (e) {}
}

// Helper to run full Ali Ahmad AI Reply + Voice/Media + 7PM Lead Queue on a specific session ('wa1' or 'wa2')
async function processClientMessageWithAliAhmad(sessionKey, replyJid, pushName, realPhone, text, isVoiceMessage, msgKey = null) {
  const sock = sessions[sessionKey]?.sock;

  const { replyText, leadStatus, mediaToSend, detectedLanguage } = await generateAliAhmadReply(
    replyJid,
    pushName,
    realPhone,
    text,
    isVoiceMessage
  );

  // Anti-Ban Shield: Always simulate realistic human read + typing/recording delay before sending!
  await simulateHumanPresenceBeforeReply(sock, replyJid, msgKey, isVoiceMessage, replyText.length);

  const askedForVoice = /\b(voice|audio|bol kar|awaaz|awaz|sunao)\b|آواز|وائس/i.test(text);
  if (isVoiceMessage || askedForVoice) {
    const spokenText = leadStatus?.voiceScript || replyText;
    const voiceLang = /[\u0600-\u06FF]/.test(spokenText) ? 'URDU_SCRIPT' : detectedLanguage;
    await sendAliAhmadVoiceNote(replyJid, spokenText, voiceLang, sessionKey);
  } else {
    await sendWhatsAppMessage(replyJid, replyText, sessionKey);
  }

  const explicitlyAskedForFile = /\b(poster|posters|photo|pic|image|flyer|brochure|pdf|file|document|bhejo|bhej|send|dikhao)\b|پوسٹر|فائل|تصویر بھیج|پی ڈی ایف/i.test(text);
  if (mediaToSend && explicitlyAskedForFile) {
    await sendWhatsAppMedia(
      replyJid,
      mediaToSend,
      `✈️ *AL-BAHR HORIZON TRAVELS & CONSULTANTS*\n📄 ${mediaToSend.name}\n🌐 www.albahrtravels.com | 📱 0343-4762264`,
      sessionKey
    );
  }

  // INSTANT CEO ALERT ONLY FOR URGENT FLIGHT / TICKET / BOOKING QUERIES!
  const isUrgentFlightOrBooking = /\b(flight|flights|ticket|tickets|ticketing|airfare|seat book|hotel book|urgent booking|confirm booking|book kar|book kr)\b|فلائٹ|ٹکٹ|ایئر ٹکٹ|بکنگ کروا|سیٹ بک/i.test(text);
  if (isUrgentFlightOrBooking) {
    const cleanPhone = (realPhone || replyJid).replace(/[^0-9]/g, '');
    const phoneDisplay = cleanPhone.startsWith('92') ? `+${cleanPhone} (https://wa.me/${cleanPhone})` : (realPhone || replyJid);
    const urgentAlert =
      `✈️ *URGENT FLIGHT / BOOKING ALERT (AL-BAHR TRAVELS)*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Client:* ${pushName}\n` +
      `📱 *Contact:* ${phoneDisplay}\n` +
      `💬 *Flight/Booking Request:* "${text}"\n` +
      `🧑‍💼 *Ali Ahmad Replied:* "${replyText.substring(0, 150)}..."\n` +
      `━━━━━━━━━━━━━━━━━━`;
    try {
      await sendWhatsAppMessage(CEO_PERSONAL_NUMBER, urgentAlert, 'wa2');
      addLog(`✈️ [Urgent Flight/Booking Alert -> 0325] Sent instant notification for ${pushName}`);
    } catch (e) {}
  }

  // All normal conversations are queued quietly for the 7:00 PM Daily Consolidated Report
  queueClientForDaily7PMReport(
    replyJid,
    pushName,
    realPhone || replyJid,
    isVoiceMessage ? `🎤 [Voice Note]: ${text}` : text,
    replyText,
    leadStatus,
    explicitlyAskedForFile ? mediaToSend?.name : null
  );
}

// Activate 'personal' or 'client' mode on 0325-7938125 for a contact
async function setPersonal0325ContactMode(targetJid, mode) {
  let entry = personal0325Contacts[targetJid];
  if (!entry) {
    entry = {
      jid: targetJid,
      name: targetJid.replace('@s.whatsapp.net', '').replace('@lid', ''),
      phone: targetJid.replace('@s.whatsapp.net', ''),
      mode,
      lastMessage: '',
      lastIsVoice: false,
      updatedAt: new Date().toLocaleTimeString(),
      promptedBoss: true
    };
    personal0325Contacts[targetJid] = entry;
  } else {
    entry.mode = mode;
    entry.updatedAt = new Date().toLocaleTimeString();
  }
  savePersonal0325Contacts();

  if (mode === 'personal') {
    addLog(`🔵 [0325 Gatekeeper] Marked ${entry.name} (${targetJid}) as PERSONAL. Ali Ahmad will stay 100% SILENT so you can chat normally.`);
    return { status: 'personal', entry };
  }

  if (mode === 'client') {
    addLog(`🟢 [0325 -> 0343 Lead Handover] Marked ${entry.name} (${targetJid}) as CLIENT! Copying number & initiating chat from Official Company Number 0343-4762264 (0325 stays 100% clean)...`);

    // Resolve destination JID for 0343-4762264 (wa2) using real phone number if available, else targetJid
    let destJid = targetJid;
    if (entry.phone && /^[0-9]{10,15}$/.test(entry.phone.replace(/[^0-9]/g, ''))) {
      let digits = entry.phone.replace(/[^0-9]/g, '');
      if (digits.startsWith('03') && digits.length === 11) {
        digits = '92' + digits.slice(1);
      }
      destJid = digits + '@s.whatsapp.net';
    }

    const honorific = guessHonorificFromName(entry.name);
    const incomingQuery = (entry.lastMessage || '').trim();
    const detectedLang = detectExactClientLanguage(incomingQuery);

    // Seed the client's memory on 0343-4762264 with the context that they first contacted CEO Sir Mubashir Ali's personal number (0325-7938125)
    let clientRec = clientMemoryDB[destJid] || clientMemoryDB[targetJid];
    if (!clientRec) {
      clientRec = {
        name: entry.name || 'Valued Client',
        phone: entry.phone || destJid,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        notes: `Referred from CEO Sir Mubashir Ali's personal number (0325-7938125). Initial query: "${incomingQuery}"`,
        messages: []
      };
      clientMemoryDB[destJid] = clientRec;
      clientMemoryDB[targetJid] = clientRec;
      saveClientMemory();
    }

    // Craft the first VIP Handover + Guidance message from Company Number 0343-4762264
    const handoverPrompt = incomingQuery
      ? `[SYSTEM NOTE: This client (${entry.name}) just messaged our CEO Sir Mubashir Ali's personal WhatsApp (0325-7938125) saying: "${incomingQuery}". Sir Mubashir Ali forwarded their number to you (Ali Ahmad) to contact them from our Official Company Number (0343-4762264). Start by politely introducing yourself as Ali Ahmad from Al-Bahr Horizon Travels & Consultants Lahore, mention that CEO Sir Mubashir Ali just shared their inquiry with you for VIP priority assistance, and immediately answer/guide them regarding "${incomingQuery}"!] Client's message: ${incomingQuery}`
      : `Assalam-o-Alaikum`;

    await processClientMessageWithAliAhmad(
      'wa2', // <-- ALWAYS SEND FROM OFFICIAL COMPANY NUMBER 0343-4762264!
      destJid,
      entry.name,
      entry.phone,
      handoverPrompt,
      Boolean(entry.lastIsVoice)
    );

    return { status: 'client', handedOverTo: '0343-4762264', destJid, entry };
  }
}

async function startSession(sessionKey) {
  const session = sessions[sessionKey];
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [`Al-Bahr Travels (${sessionKey.toUpperCase()})`, 'Chrome', '1.0.0']
    });

    session.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        session.qr = await QRCode.toDataURL(qr);
        session.status = 'Waiting for QR Scan';
        addLog(`[${sessionKey.toUpperCase()}] New QR Code ready to scan.`);
      }
      if (connection === 'close') {
        session.qr = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // If statusCode === 440 (Connection Replaced by Cloud Server or Laptop), do NOT fight in an infinite loop!
        if (statusCode === 440) {
          conflictCount[sessionKey] = (conflictCount[sessionKey] || 0) + 1;
          const isCloudEnv = Boolean(process.env.GITHUB_ACTIONS || process.env.RENDER || process.env.VERCEL);
          if (!isCloudEnv && conflictCount[sessionKey] >= 1) {
            // We are on the local laptop and the Cloud Server is actively running! Switch local display to "Active on 24/7 Cloud Server" instead of fighting the cloud!
            session.status = 'Connected (Active on 24/7 Cloud Server ☁️)';
            addLog(`☁️ [${sessionKey.toUpperCase()}] Cloud Server is actively handling this WhatsApp number 24/7! Local laptop entered Standby Monitoring Mode (no conflict).`);
            return;
          }
          // If on Cloud and local laptop briefly took over, wait 45 seconds before re-claiming so there is no rapid 440 loop
          session.status = 'Standby (Reclaiming in 45s)';
          addLog(`[${sessionKey.toUpperCase()}] Session active elsewhere (code 440). Waiting 45s before reconnecting...`);
          setTimeout(() => startSession(sessionKey), 45000);
          return;
        }

        session.status = 'Disconnected';
        addLog(`[${sessionKey.toUpperCase()}] Disconnected (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) {
          setTimeout(() => startSession(sessionKey), 3000);
        }
      } else if (connection === 'open') {
        conflictCount[sessionKey] = 0;
        session.qr = null;
        session.status = 'Connected';
        session.user = sock.user;
        addLog(`[${sessionKey.toUpperCase()}] Connected as ${sock.user?.name || 'Al-Bahr Travels'} (${sock.user?.id || ''})`);
      }
    });

    sock.ev.on('call', async (calls) => {
      for (const callEvent of calls) {
        await handleIncomingWhatsAppCall(sessionKey, callEvent);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify' && m.type !== 'append') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        const msgTime = Number(msg.messageTimestamp || 0);
        if (msgTime && Math.abs(Date.now() / 1000 - msgTime) > 120) continue;
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        const senderPn = msg.key.senderPn || msg.key.participantPn || '';

        if (
          remoteJid === 'status@broadcast' ||
          remoteJid.endsWith('@g.us') ||
          remoteJid.endsWith('@newsletter') ||
          remoteJid.endsWith('@broadcast')
        ) {
          continue;
        }

        const replyJid = senderPn || remoteJid;
        const realPhone = (senderPn || (remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : ''))
          .replace('@s.whatsapp.net', '')
          .replace(/[^0-9]/g, '');
        const pushName = msg.pushName || 'Client';

        // Never cross-trigger between our own two numbers (0325 <-> 0343) when sending system alerts
        const rawTextCheck =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.ephemeralMessage?.message?.conversation ||
          msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
          '';

        if (
          rawTextCheck.includes('📋 *DAILY 7:00 PM') ||
          rawTextCheck.includes('📞 *INCOMING WHATSAPP CALL') ||
          rawTextCheck.includes('🔔 *PERSONAL NUMBER (0325) NEW MESSAGE') ||
          rawTextCheck.includes('✅ *Boss!*') ||
          rawTextCheck.includes('🔵 *Personal Mode Active*')
        ) {
          continue;
        }

        const audioMsg = msg.message.audioMessage || msg.message.ephemeralMessage?.message?.audioMessage;
        let isVoiceMessage = false;
        let text = rawTextCheck || msg.message.imageMessage?.caption || '';

        // =========================================================================
        // CASE A: MESSAGE RECEIVED ON WA2 (0343-4762264 — OFFICIAL BUSINESS NUMBER)
        // =========================================================================
        if (sessionKey === 'wa2') {
          // 1. Check if CEO (0325-7938125) sent a command to 0343-4762264 (e.g. choosing Personal vs Client for 0325, or Call 1/2)
          const isFromCEO = realPhone.endsWith('3257938125') || remoteJid.includes('156259768643587');
          const cmd = text.trim().toLowerCase();

          if (isFromCEO && (cmd === '1' || cmd === 'personal' || cmd === 'p' || cmd === '2' || cmd === 'client' || cmd === 'c')) {
            const chosenMode = (cmd === '1' || cmd === 'personal' || cmd === 'p') ? 'personal' : 'client';
            const targetJidToUse = lastPending0325Jid || Object.keys(personal0325Contacts).pop();
            if (!targetJidToUse) {
              await sendWhatsAppMessage(
                replyJid,
                `ℹ️ *Boss!* Is waqt aapke personal number (0325) par koi naya pending message nahi hai. Jab 0325 par kisi naye banday ka message aaye ga tab aap 1 (Personal) ya 2 (Client) likh kar select کر saktay hain!`,
                'wa2'
              );
              continue;
            }
            const targetEntry = personal0325Contacts[targetJidToUse];
            const targetName = targetEntry?.name || targetJidToUse;
            await setPersonal0325ContactMode(targetJidToUse, chosenMode);
            if (chosenMode === 'personal') {
              await sendWhatsAppMessage(
                replyJid,
                `🔵 *Personal Mode Active (${targetName}):*\nBoss, main اس نمبر پر بالکل خاموش رہوں گا۔ آپ اپنی نارمل پرسنل چیٹ جاری رکھیں!`,
                'wa2'
              );
            } else {
              await sendWhatsAppMessage(
                replyJid,
                `🟢 *Client Handed Over to Company Number (0343-4762264):*\n✅ Boss! *${targetName}* ka number copy کر ke hamaray Official Company Number (*0343-4762264*) se Ali Ahmad ne unko VIP message bhej diya hai! Aapke personal number (0325) se koi auto-reply nahi jaye ga.`,
                'wa2'
              );
            }
            continue;
          }

          if (
            isFromCEO &&
            lastCallerPendingPermission &&
            !lastCallerPendingPermission.handled &&
            Date.now() - lastCallerPendingPermission.timestamp < 180000 &&
            (cmd === 'call 1' || cmd === 'call 2')
          ) {
            lastCallerPendingPermission.handled = true;
            if (lastCallerPendingPermission.timer) clearTimeout(lastCallerPendingPermission.timer);
            if (cmd === 'call 1') {
              const { callerJid, callerName, honorific, sessionKey: callSess } = lastCallerPendingPermission;
              await sendWhatsAppMessage(replyJid, `✅ *Boss!* Main abhi *${callerName}* ko Voice Note 🎤 bhej kar handle kar raha hoon!`, 'wa2');
              await engageCallerWithAliAhmadVoice(callerJid, callerName, honorific, callSess);
            } else {
              await sendWhatsAppMessage(replyJid, `👍 *Theek hai Boss!* Aap khud call attend kar lein.`, 'wa2');
            }
            continue;
          }

          // Normal client messaging 0343-4762264 -> Full Automatic Ali Ahmad AI!
          if (audioMsg) {
            isVoiceMessage = true;
            addLog(`[Voice Note -> 0343-4762264] From ${pushName} (${audioMsg.seconds || '?'}s) — Listening & transcribing...`);
            try { await sock.sendPresenceUpdate('composing', replyJid); } catch (e) {}
            const transcribed = await transcribeWhatsAppAudio(sock, msg);
            text = transcribed || '[Client sent a voice message; kindly acknowledge respectfully as Sir/Madam]';
            addLog(`[Voice Note Transcribed] ${pushName}: "${text}"`);
          }

          if (!text.trim()) continue;
          if (!isVoiceMessage) {
            addLog(`[Client -> 0343-4762264] ${pushName} (${realPhone ? '+' + realPhone : replyJid}): "${text}"`);
          }

          const cooldownKey = `wa2:${replyJid}:${text.trim().toLowerCase()}`;
          if (!isVoiceMessage && repliedCooldown.has(cooldownKey) && Date.now() - repliedCooldown.get(cooldownKey) < 5000) {
            continue;
          }
          repliedCooldown.set(cooldownKey, Date.now());

          await processClientMessageWithAliAhmad('wa2', replyJid, pushName, realPhone, text, isVoiceMessage, msg.key);
          continue;
        }

        // =========================================================================
        // CASE B: MESSAGE RECEIVED ON WA1 (0325-7938125 — CEO PERSONAL NUMBER)
        // =========================================================================
        if (sessionKey === 'wa1') {
          // Ignore messages coming from our own business number 0343-4762264
          if (realPhone.endsWith('3434762264') || remoteJid.includes('66224604115019')) {
            continue;
          }

          if (audioMsg) {
            isVoiceMessage = true;
            const transcribed = await transcribeWhatsAppAudio(sock, msg);
            text = transcribed || '[Voice Note]';
          }
          if (!text.trim()) continue;

          let contactEntry = personal0325Contacts[replyJid];
          if (!contactEntry) {
            contactEntry = {
              jid: replyJid,
              name: pushName,
              phone: realPhone || replyJid,
              mode: 'pending', // ALWAYS start as 'pending' (100% SILENT until Boss chooses Personal vs Client!)
              lastMessage: text,
              lastIsVoice: isVoiceMessage,
              updatedAt: new Date().toLocaleTimeString(),
              promptedBoss: false
            };
            personal0325Contacts[replyJid] = contactEntry;
          } else {
            if (pushName && pushName !== 'Client') contactEntry.name = pushName;
            if (realPhone) contactEntry.phone = realPhone;
            contactEntry.lastMessage = text;
            contactEntry.lastIsVoice = isVoiceMessage;
            contactEntry.updatedAt = new Date().toLocaleTimeString();
          }
          savePersonal0325Contacts();

          // 1. If marked as PERSONAL -> Stay 100% SILENT! Do nothing at all!
          if (contactEntry.mode === 'personal') {
            addLog(`🔵 [0325 Personal Chat] ${contactEntry.name}: "${text.substring(0, 50)}" (Ali Ahmad is SILENT)`);
            continue;
          }

          // 2. If marked as CLIENT -> Never reply from 0325! Forward any new message they send to 0325 straight to Ali Ahmad on Company Number 0343-4762264!
          if (contactEntry.mode === 'client') {
            addLog(`🟢 [0325 -> 0343 Redirect] ${contactEntry.name} messaged 0325: "${text.substring(0, 60)}" -> Ali Ahmad replying from Company Number 0343-4762264 (0325 stays silent)!`);
            const cooldownKey = `wa1to2:${replyJid}:${text.trim().toLowerCase()}`;
            if (!isVoiceMessage && repliedCooldown.has(cooldownKey) && Date.now() - repliedCooldown.get(cooldownKey) < 5000) {
              continue;
            }
            repliedCooldown.set(cooldownKey, Date.now());
            let destJid = replyJid;
            if (contactEntry.phone && /^[0-9]{10,15}$/.test(contactEntry.phone.replace(/[^0-9]/g, ''))) {
              let digits = contactEntry.phone.replace(/[^0-9]/g, '');
              if (digits.startsWith('03') && digits.length === 11) digits = '92' + digits.slice(1);
              destJid = digits + '@s.whatsapp.net';
            }
            await processClientMessageWithAliAhmad('wa2', destJid, contactEntry.name, contactEntry.phone, text, isVoiceMessage);
            continue;
          }

          // 3. Otherwise mode === 'pending' -> DO NOT reply to the sender! Ask Boss on Dashboard & via 0343->0325 Notification!
          lastPending0325Jid = replyJid;
          addLog(`🟡 [0325 Waiting Your Choice] ${contactEntry.name} sent: "${text.substring(0, 60)}" -> Click [Personal] or [Client] on Dashboard (or reply 1 / 2)!`);

          if (!contactEntry.promptedBoss) {
            contactEntry.promptedBoss = true;
            savePersonal0325Contacts();
            const askBossMsg =
              `🔔 *PERSONAL NUMBER (0325) NEW MESSAGE*\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `👤 *Sender:* ${contactEntry.name} (${contactEntry.phone.replace('@s.whatsapp.net', '')})\n` +
              `💬 *Message:* "${text.substring(0, 120)}"\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `❓ *Boss, ye Personal hai ya Client?*\n\n` +
              `👉 Reply *"1"* ya *"Personal"* — Normal Personal Chat (Ali Ahmad bilkul khamosh rahega).\n` +
              `👉 Reply *"2"* ya *"Client"* — Is number par Ali Ahmad (AI Agent) foran Active ho jaye ga!\n` +
              `*(Ya apne Browser Dashboard http://localhost:3001 par [Personal] ya [Client] button click karein)*`;
            try {
              await sendWhatsAppMessage(CEO_PERSONAL_NUMBER, askBossMsg, 'wa2');
            } catch (e) {}
          }
        }
      }
    });
  } catch (err) {
    addLog(`[${sessionKey.toUpperCase()}] Error: ${err.message}`);
    setTimeout(() => startSession(sessionKey), 5000);
  }
}

// Daily 7:00 PM (19:00 PKT) Lead Digest Queue — NO per-message lead spam on 0325-7938125!
const dailyPendingLeads = new Map();
let lastDailyReportDate = '';

function queueClientForDaily7PMReport(clientJid, clientName, clientPhoneOrJid, lastClientMsg, lastAliReply, leadStatus, sentFileName) {
  const clientRecord = clientMemoryDB[clientJid] || {};
  const summary = leadStatus?.updatedClientNotes || leadStatus?.summary || clientRecord.notes || lastClientMsg;
  const totalMsgs = (clientRecord.messages || []).filter(m => m.role === 'user').length;

  dailyPendingLeads.set(clientJid, {
    clientName: clientRecord.name || clientName,
    clientContact: clientPhoneOrJid,
    totalMsgs,
    summary,
    lastClientMsg,
    lastAliReply,
    sentFileName: sentFileName || dailyPendingLeads.get(clientJid)?.sentFileName || '',
    updatedAt: new Date().toLocaleTimeString()
  });

  clientRecord.pendingDailyReport = true;
  saveClientMemory();
  addLog(`[Daily 7PM Digest] Queued/Updated lead for ${clientName} (Total queued today: ${dailyPendingLeads.size} clients — Will send at 7:00 PM).`);
}

async function sendDaily7PMLeadDigestToCEO(forceManual = false) {
  if (dailyPendingLeads.size === 0) {
    if (forceManual) {
      await sendWhatsAppMessage(CEO_PERSONAL_NUMBER, `📋 *DAILY 7:00 PM LEAD REPORT (AL-BAHR TRAVELS)*\nآج ابھی تک کوئی نئی کلائنٹ لیڈ جمع نہیں ہوئی۔`, 'wa2');
    }
    return;
  }

  let report =
    `📋 *DAILY 7:00 PM CONSOLIDATED LEADS REPORT*\n` +
    `*AL-BAHR HORIZON TRAVELS & CONSULTANTS*\n` +
    `📅 *Date:* ${new Date().toLocaleDateString('en-PK')} | 🕖 *7:00 PM Digest*\n` +
    `👥 *Total Active Clients Today:* ${dailyPendingLeads.size}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  let idx = 1;
  for (const [jid, item] of dailyPendingLeads.entries()) {
    const cleanPhone = (item.clientContact || '').replace(/[^0-9]/g, '');
    const phoneDisplay = cleanPhone.startsWith('92') ? `+${cleanPhone} (https://wa.me/${cleanPhone})` : item.clientContact;
    report +=
      `*${idx}. 👤 ${item.clientName}*\n` +
      `📱 *Contact:* ${phoneDisplay}\n` +
      `💬 *Messages Exchanged:* ${item.totalMsgs} (Last at ${item.updatedAt})\n` +
      `🎯 *Complete Discussion Summary:* ${item.summary}\n` +
      (item.sentFileName ? `📎 *Files Sent:* ${item.sentFileName}\n` : '') +
      `🔚 *Last Message:* "${item.lastClientMsg.substring(0, 120)}"\n` +
      `──────────────────\n`;
    idx++;
  }

  report += `✅ *All clients were guided & handled by Ali Ahmad.*`;

  try {
    await sendWhatsAppMessage(CEO_PERSONAL_NUMBER, report, 'wa2');
    addLog(`🕖 [Daily 7:00 PM Report Sent -> 0325-7938125] Sent consolidated digest of ${dailyPendingLeads.size} clients!`);
    dailyPendingLeads.clear();
  } catch (e) {
    addLog(`[Daily 7PM Report Error] ${e.message}`);
  }
}

setInterval(() => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getHours() === 19 && now.getMinutes() === 0 && lastDailyReportDate !== dateStr) {
    lastDailyReportDate = dateStr;
    sendDaily7PMLeadDigestToCEO(false);
  }
}, 30000);

// Endpoint for 1-Click Personal vs Client Toggle from Browser Dashboard
app.post('/set-0325-mode', async (req, res) => {
  try {
    const { jid, mode } = req.body;
    if (!jid || !['personal', 'client'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'Invalid jid or mode' });
    }
    const result = await setPersonal0325ContactMode(jid, mode);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/ai-reply', async (req, res) => {
  try {
    const { From, ClientPhone, ProfileName, Body, IsVoiceNote } = req.body;
    const result = await generateAliAhmadReply(
      From || 'test',
      ProfileName || 'Client',
      ClientPhone || '',
      Body || '',
      Boolean(IsVoiceNote)
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-voice', async (req, res) => {
  try {
    const { to, text, langMode, sessionKey } = req.body;
    if (!to || !text) return res.status(400).json({ success: false, error: 'Missing to/text' });
    await sendAliAhmadVoiceNote(to, text, langMode || 'URDU_SCRIPT', sessionKey || 'wa2');
    res.json({ success: true, to });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-media', async (req, res) => {
  try {
    const { to, query, caption, sessionKey } = req.body;
    const item = await findOrGenerateTravelMedia(query || 'iqama');
    if (!item) return res.status(404).json({ success: false, error: 'No media found' });
    await sendWhatsAppMedia(to, item, caption || `✈️ *AL-BAHR HORIZON TRAVELS & CONSULTANTS*\n📄 ${item.name}\n🌐 www.albahrtravels.com | 📱 0343-4762264`, sessionKey || 'wa2');
    res.json({ success: true, sent: item.name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve 1-Click Android Termux Installer & Bundle so the user can install everything on their Android phone with 1 command!
app.get('/termux', (req, res) => {
  try {
    const tunnelUrl = fs.existsSync(path.join(__dirname, 'current_tunnel_url.txt'))
      ? fs.readFileSync(path.join(__dirname, 'current_tunnel_url.txt'), 'utf8').trim()
      : `http://${req.headers.host}`;
    const script = fs.readFileSync(path.join(__dirname, 'termux-install.sh'), 'utf8')
      .replace(/__TUNNEL_URL__/g, tunnelUrl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/termux-bundle.tar.gz', (req, res) => {
  const bundlePath = path.join(__dirname, 'termux-bundle.tar.gz');
  if (fs.existsSync(bundlePath)) {
    res.download(bundlePath, 'termux-bundle.tar.gz');
  } else {
    res.status(404).send('Bundle not found');
  }
});

// ============================================================================
// 100% FREE LIVE REAL-TIME VOICE CALL ROOM ENDPOINTS (/call, /live-call-turn)
// ============================================================================
app.get('/call', (req, res) => {
  const callHtmlPath = path.join(__dirname, 'live_call.html');
  if (fs.existsSync(callHtmlPath)) {
    res.sendFile(callHtmlPath);
  } else {
    res.status(404).send('Live call room not found');
  }
});

app.post('/live-call-turn', async (req, res) => {
  try {
    const { jid, name, text, lang, isGreeting } = req.body;
    const callerJid = jid || 'live_caller';
    const callerName = name || 'Valued Client';
    const honorific = guessHonorificFromName(callerName);
    const titleUr = honorific.gender === 'Female' ? 'محترمہ' : 'سر';
    const titleEn = honorific.enHonorific;

    let replyText = '';
    let voiceLang = lang === 'en-US' ? 'PURE_ENGLISH' : 'URDU_SCRIPT';

    if (isGreeting || text === '[CALL_CONNECTED_GREETING]') {
      if (lang === 'en-US') {
        replyText = `Assalam-o-Alaikum ${titleEn}! This is Ali Ahmad speaking live from Al Bahr Horizon Travels and Consultants, Lahore. Welcome to our live voice desk. Please tell me how I can help you today with your Umrah package, work visa, Iqama, or visit visa!`;
      } else {
        replyText = `السلام علیکم ${titleUr}! میں علی احمد لائیو بات کر رہا ہوں، ال بحر، ہورائزن ٹریولز اینڈ کنسلٹنٹس لاہور سے۔ فرمائیں ${titleUr}، میں آج آپ کی عمرہ پیکج، سعودی اقامہ، ورک ویزا یا وزٹ ویزا کے حوالے سے کیا خدمت کر سکتا ہوں؟`;
      }
      addLog(`📞 [Live Call Connected] Ali Ahmad greeted ${callerName} (${callerJid})`);
    } else {
      addLog(`📞 [Live Call Speech from ${callerName}]: "${text}"`);
      const aiRes = await generateAliAhmadReply(callerJid, callerName, callerJid, text, true);
      replyText = aiRes.leadStatus?.voiceScript || aiRes.replyText;
      voiceLang = /[\u0600-\u06FF]/.test(replyText) ? 'URDU_SCRIPT' : aiRes.detectedLanguage;

      // Also if client asked for a poster during the live call, send it to their WhatsApp simultaneously!
      const explicitlyAskedForFile = /\b(poster|posters|photo|pic|image|flyer|brochure|pdf|file|document|bhejo|bhej|send|dikhao)\b|پوسٹر|فائل|تصویر بھیج|پی ڈی ایف/i.test(text);
      if (aiRes.mediaToSend && explicitlyAskedForFile && callerJid.includes('@')) {
        sendWhatsAppMedia(
          callerJid,
          aiRes.mediaToSend,
          `✈️ *AL-BAHR HORIZON TRAVELS & CONSULTANTS*\n📄 ${aiRes.mediaToSend.name}\n🌐 www.albahrtravels.com | 📱 0343-4762264`,
          'wa2'
        ).catch(() => {});
      }

      queueClientForDaily7PMReport(
        callerJid,
        callerName,
        callerJid,
        `📞 [Live Voice Call]: ${text}`,
        replyText,
        aiRes.leadStatus,
        explicitlyAskedForFile ? aiRes.mediaToSend?.name : null
      );
    }

    const tmpOutOgg = path.join(os.tmpdir(), `live_call_out_${Date.now()}.ogg`);
    await execFileAsync('python3', [GENERATE_VOICE_SCRIPT, replyText, voiceLang, tmpOutOgg], { timeout: 25000 });
    const audioBase64 = fs.readFileSync(tmpOutOgg).toString('base64');
    fs.unlinkSync(tmpOutOgg);

    res.json({ success: true, replyText, audioBase64 });
  } catch (err) {
    addLog(`[Live Call Turn Error] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/live-call-audio-turn', async (req, res) => {
  try {
    const { jid, name, audioBase64, lang } = req.body;
    const tmpInOgg = path.join(os.tmpdir(), `live_call_in_${Date.now()}.ogg`);
    fs.writeFileSync(tmpInOgg, Buffer.from(audioBase64, 'base64'));
    let transcript = '';
    try {
      const { stdout } = await execFileAsync('python3', [TRANSCRIBE_SCRIPT, tmpInOgg], { timeout: 20000 });
      transcript = (stdout || '').trim();
    } catch (e) {}
    if (fs.existsSync(tmpInOgg)) fs.unlinkSync(tmpInOgg);

    if (!transcript) {
      return res.json({ success: true, transcript: '', replyText: 'جی سر، آپ کی آواز صاف نہیں آئی، براہ کرم دوبارہ بولیں۔', audioBase64: '' });
    }

    const callerJid = jid || 'live_caller';
    const callerName = name || 'Valued Client';
    const aiRes = await generateAliAhmadReply(callerJid, callerName, callerJid, transcript, true);
    const replyText = aiRes.leadStatus?.voiceScript || aiRes.replyText;
    const voiceLang = /[\u0600-\u06FF]/.test(replyText) ? 'URDU_SCRIPT' : aiRes.detectedLanguage;

    const tmpOutOgg = path.join(os.tmpdir(), `live_call_out_${Date.now()}.ogg`);
    await execFileAsync('python3', [GENERATE_VOICE_SCRIPT, replyText, voiceLang, tmpOutOgg], { timeout: 25000 });
    const outBase64 = fs.readFileSync(tmpOutOgg).toString('base64');
    fs.unlinkSync(tmpOutOgg);

    res.json({ success: true, transcript, replyText, audioBase64: outBase64 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/status', (req, res) => {
  const catalog = getAvailableMediaCatalog();
  res.json({
    agentName: 'Ali Ahmad (Dual-Number Smart AI Marketing & Voice Specialist)',
    businessWhatsApp0343: {
      number: '0343-4762264',
      status: sessions.wa2.status,
      user: sessions.wa2.user,
      qr: sessions.wa2.qr
    },
    personalWhatsApp0325: {
      number: '0325-7938125',
      status: sessions.wa1.status,
      user: sessions.wa1.user,
      qr: sessions.wa1.qr,
      contacts: Object.values(personal0325Contacts).reverse()
    },
    savedClientsCount: Object.keys(clientMemoryDB).length,
    queuedFor7PMCount: dailyPendingLeads.size,
    indexedPostersAndFilesCount: catalog.length,
    logs: recentLogs
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Al-Bahr Travels — AI Marketing Agent (Ali Ahmad)</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 1040px; margin: 0 auto; }
    .card { background: #1e293b; border-radius: 16px; padding: 22px; border: 1px solid #334155; margin-bottom: 18px; }
    h1 { margin: 0 0 8px 0; color: #22c55e; font-size: 22px; }
    h2 { margin: 0 0 12px 0; color: #38bdf8; font-size: 18px; }
    .badge { display: inline-block; padding: 4px 11px; border-radius: 999px; font-weight: 600; font-size: 12px; }
    .Connected { background: #166534; color: #dcfce7; }
    .pending { background: #854d0e; color: #fef08a; }
    .personal { background: #1e40af; color: #dbeafe; }
    .client { background: #166534; color: #dcfce7; }
    .contact-row { display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 14px 16px; border-radius: 12px; margin-bottom: 10px; border: 1px solid #334155; flex-wrap: wrap; gap: 12px; }
    .btn { cursor: pointer; border: none; padding: 9px 16px; border-radius: 8px; font-weight: 700; font-size: 13px; transition: 0.15s; }
    .btn-personal { background: #2563eb; color: #fff; }
    .btn-personal:hover { background: #1d4ed8; }
    .btn-client { background: #16a34a; color: #fff; }
    .btn-client:hover { background: #15803d; }
    .logs { background: #020617; color: #38bdf8; font-family: monospace; padding: 14px; border-radius: 10px; height: 220px; overflow-y: auto; font-size: 12px; margin-top: 10px; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card" style="border-color:#22c55e;">
      <h1>🧑‍💼 AL-BAHR HORIZON TRAVELS & CONSULTANTS — AI Agent: ALI AHMAD</h1>
      <div style="color:#cbd5e1; font-size:14px; line-height:1.8;">
        🟢 <strong>Official Business Number (0343-4762264):</strong> <span id="st-0343" class="badge Connected">Loading...</span> (100% Auto-Reply Active for All Clients)<br/>
        🛡️ <strong>CEO Personal Number (0325-7938125):</strong> <span id="st-0325" class="badge Connected">Loading...</span> (<strong>Safe Gatekeeper Mode:</strong> Silent by default until you click <em>Personal</em> or <em>Client</em> below!)<br/>
        🕖 <strong>Daily Lead Report:</strong> Sends 1 Consolidated Report at <strong>7:00 PM</strong> (<span id="q-count">0</span> clients queued today) • <span id="mem-count">0</span> Clients in Permanent Memory
      </div>
    </div>

    <div class="card" style="border-color:#38bdf8;">
      <h2>📲 Personal Number (0325-7938125) — Choose [👤 Personal] or [💼 Client (Activate Ali Ahmad)]</h2>
      <div style="color:#94a3b8; font-size:13px; margin-bottom:14px;">
        Jab bhi 0325 par kisi naye banday ka message aaye ga, wo yahan show hoga. Jab tak aap <strong>Client</strong> par click nahi karenge, Ali Ahmad usay koi auto-reply nahi karega!
      </div>
      <div id="contacts-list">No messages on 0325 yet...</div>
    </div>

    <div class="card">
      <div style="font-weight:600; font-size:15px;">Live Activity, Voice Notes & Gatekeeper Logs:</div>
      <div id="logs" class="logs">Loading...</div>
    </div>
  </div>

  <script>
    async function setMode(jid, mode) {
      await fetch('/set-0325-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, mode })
      });
      poll();
    }

    async function poll() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        document.getElementById('st-0343').textContent = data.businessWhatsApp0343.status;
        document.getElementById('st-0325').textContent = data.personalWhatsApp0325.status;
        document.getElementById('mem-count').textContent = data.savedClientsCount;
        document.getElementById('q-count').textContent = data.queuedFor7PMCount;

        const list = data.personalWhatsApp0325.contacts || [];
        const container = document.getElementById('contacts-list');
        if (list.length === 0) {
          container.innerHTML = '<div style="color:#64748b;font-style:italic;">Abhi 0325-7938125 par koi naya message nahi aaya. Jaise hi message aayega yahan [Personal] aur [Client] ke buttons aa jayenge.</div>';
        } else {
          container.innerHTML = list.map(c => {
            const modeLabel = c.mode === 'client' ? '💼 CLIENT (Ali Ahmad Active)' : (c.mode === 'personal' ? '👤 PERSONAL (Normal Chat - AI Silent)' : '⏳ WAITING YOUR CHOICE (AI Silent)');
            return \`
              <div class="contact-row">
                <div>
                  <div style="font-weight:700;font-size:15px;">\${c.name} <span style="color:#94a3b8;font-weight:400;font-size:13px;">(\${c.phone})</span> <span class="badge \${c.mode}">\${modeLabel}</span></div>
                  <div style="color:#cbd5e1;font-size:13px;margin-top:4px;">💬 Last Message (\${c.updatedAt}): "\${c.lastMessage}"</div>
                </div>
                <div style="display:flex;gap:10px;">
                  <button class="btn btn-personal" onclick="setMode('\${c.jid}', 'personal')">👤 Personal (Normal Chat)</button>
                  <button class="btn btn-client" onclick="setMode('\${c.jid}', 'client')">💼 Client (Activate Ali Ahmad)</button>
                </div>
              </div>
            \`;
          }).join('');
        }

        document.getElementById('logs').innerHTML = (data.logs || []).map(l => '<div>' + l + '</div>').join('');
      } catch (e) {}
    }
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  const catalog = getAvailableMediaCatalog();
  addLog(`Ali Ahmad Dual-WhatsApp Smart Gatekeeper running on http://localhost:${PORT}`);
  addLog(`0343-4762264 = 100% Auto-Reply | 0325-7938125 = Safe Personal/Client Choice Mode | 7:00 PM Daily Lead Digest.`);
  startSession('wa1');
  startSession('wa2');
});
