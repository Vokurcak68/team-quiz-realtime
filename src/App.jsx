import React, { useEffect, useMemo, useRef, useState } from "react";

// =============================================
// Síťový týmový kvíz (2–5 hráčů) – React + Firestore (CDN)
// =============================================
// • Import otázek z JSONu (kompat.: { q, options[], answer, comment? })
// • Týmový režim: kvíz končí, když jsou VŠECHNY otázky vyřešeny LIBOVOLNÝM hráčem
// • Špatná odpověď = 10s globální zámek (pauza) s informací, kdo ji způsobil
// • Chat a log odpovědí (po dokončení kvízu)
// • POP‑UP okno pro každou otázku (volitelné). Klik na číslo → nové okno.
//   – Toggle „Otevírat v novém okně“ (výchozí zapnuto)
//   – Popup odešle odpověď do hlavního okna; hlavní okno vše zapíše do Firestore
//   – Po vyhodnocení se popup s hláškou zavře do ~1.5 s
// =============================================

// --- Výchozí (placeholder) config – šablona pro UI ---
const firebaseConfigDefaults = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// --- TRVALÁ KONFIGURACE ZE SOUBORU / KÓDU ---
// 1) Preferuje se soubor /firebase.config.json (veřejný, JSON ve stejném tvaru)
// 2) Pokud soubor není, použije se tato statická konstanta (vyplňte jednou a hráči už nic neřeší)
const STATIC_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDDzIg_K4HT0GSYZR8X_Drhxg9r066jiNk",
  authDomain: "kviz-a3c45.firebaseapp.com",
  projectId: "kviz-a3c45",
  storageBucket: "kviz-a3c45.appspot.com",
  messagingSenderId: "42428150893",
  appId: "1:42428150893:web:7af0d07dd45eaff935fb64",
};

// --- Firebase přes CDN (bez npm) ---
const FIREBASE_JS_VER = "10.12.2"; // případně aktualizujte
let _fs = null; // modul firestore
let _db = null; // instance databáze
let _initialized = false;

async function getFS(activeConfig) {
  if (_fs && _db && _initialized) return { fs: _fs, db: _db };
  const { initializeApp } = await import(
    /* @vite-ignore */ `https://www.gstatic.com/firebasejs/${FIREBASE_JS_VER}/firebase-app.js`
  );
  const fs = await import(
    /* @vite-ignore */ `https://www.gstatic.com/firebasejs/${FIREBASE_JS_VER}/firebase-firestore.js`
  );
  const app = initializeApp(activeConfig);
  const db = fs.getFirestore(app);
  _fs = fs; _db = db; _initialized = true;
  return { fs, db };
}

// === Utility ===
const DEFAULT_PENALTY_MS = 10_000; // výchozí 10s globální zámek
const LS_FB = "tqr:fbconfig";
const LS_QS = "tqr:questions"; // uložená lokální sada (z importu)

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizeRoom(code) {
  return (code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "QUIZ";
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

function classNames(...xs) { return xs.filter(Boolean).join(" "); }

function loadSavedConfig() {
  try { const raw = localStorage.getItem(LS_FB); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function loadSavedQuestions() {
  try { const raw = localStorage.getItem(LS_QS); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function saveQuestionsToLS(qs) { try { localStorage.setItem(LS_QS, JSON.stringify(qs)); } catch {} }
function clearSavedQuestions() { try { localStorage.removeItem(LS_QS); } catch {} }

function isConfigReady(cfg) {
  if (!cfg) return false;
  const vals = [cfg.apiKey, cfg.authDomain, cfg.projectId, cfg.storageBucket, cfg.messagingSenderId, cfg.appId];
  return vals.every((v) => typeof v === "string" && v.trim().length > 0 && !v.includes("REPLACE_ME"));
}

// === Načítání otázek ===
function validateQuestions(payload) {
  const arr = Array.isArray(payload?.questions) ? payload.questions : Array.isArray(payload) ? payload : [];
  const clean = [];
  for (const item of arr) {
    if (!item || typeof item.q !== "string") continue;
    const options = Array.isArray(item.options) ? item.options.filter((o) => typeof o === "string") : [];
    const answer = Number.isInteger(item.answer) ? item.answer : -1;
    if (options.length < 2 || answer < 0 || answer >= options.length) continue;
    const comment = typeof item.comment === 'string' ? item.comment : (typeof item.explanation === 'string' ? item.explanation : "");
    clean.push({ q: item.q, options, answer, comment });
  }
  return clean;
}

const FALLBACK_QUESTIONS = [
  { q: "Jaké je hlavní město České republiky?", options: ["Brno", "Praha", "Ostrava", "Plzeň"], answer: 1 },
  { q: "Jaká měna se používá v České republice?", options: ["Euro", "Česká koruna", "Zlotý", "Forint"], answer: 1 },
  { q: "Která řeka protéká Prahou?", options: ["Labe", "Morava", "Vltava", "Odra"], answer: 2 },
  { q: "Nejvyšší hora ČR je…", options: ["Lysá hora", "Sněžka", "Radhošť", "Praděd"], answer: 1 },
  { q: "Kolik krajů má ČR (vč. Prahy)?", options: ["10", "13", "14", "15"], answer: 2 },
];

async function loadQuestionBankFromFile(file) {
  const text = await file.text();
  try {
    const json = JSON.parse(text);
    const qs = validateQuestions(json);
    if (!qs.length) throw new Error("Soubor neobsahuje platné otázky.");
    return qs;
  } catch (e) {
    throw new Error("Neplatný JSON: " + e.message);
  }
}

async function loadQuestionBankDefault() {
  try {
    const res = await fetch("/questions.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const qs = validateQuestions(data);
    return qs.length ? qs : FALLBACK_QUESTIONS;
  } catch (e) {
    return FALLBACK_QUESTIONS;
  }
}

// === Hlavní komponenta ===
export default function TeamQuizRealtime() {
  // Persistence klienta
  const [myId] = useState(() => localStorage.getItem("tqr:id") || (localStorage.setItem("tqr:id", uid()), localStorage.getItem("tqr:id")));
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem("tqr:room") || "");
  const [nick, setNick] = useState(() => localStorage.getItem("tqr:nick") || "");

  // Firebase config (editovatelný přímo v UI)
  const [firebaseCfg, setFirebaseCfg] = useState(() => ({ ...firebaseConfigDefaults, ...loadSavedConfig() }));
  const [fileConfig, setFileConfig] = useState(null);

  // Načti /firebase.config.json pokud existuje (před UI/LS)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/firebase.config.json", { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (isConfigReady(json)) setFileConfig(json);
        }
      } catch (_) {}
    })();
  }, []);

  const cfgLockedByFile = isConfigReady(fileConfig);
  const cfgLockedByStatic = !cfgLockedByFile && isConfigReady(STATIC_FIREBASE_CONFIG);
  const activeConfig = useMemo(() => {
    if (cfgLockedByFile) return fileConfig;
    if (cfgLockedByStatic) return STATIC_FIREBASE_CONFIG;
    return firebaseCfg;
  }, [cfgLockedByFile, cfgLockedByStatic, fileConfig, firebaseCfg]);
  const configReady = useMemo(() => isConfigReady(activeConfig), [activeConfig]);

  // Stavy hry
  const [stage, setStage] = useState("intro"); // intro | lobby | game | admin
  const [room, setRoom] = useState(null); // dokument místnosti
  const [players, setPlayers] = useState([]); // seznam hráčů z Firestore
  const [localQuestions, setLocalQuestions] = useState(null); // lokální sada (fallback nebo import)
  const [loading, setLoading] = useState(false);
  
  // Admin sekce
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [allRooms, setAllRooms] = useState([]);
  const [questionSets, setQuestionSets] = useState({}); // { setId: { name, questions: [...] } }
  const [newSetName, setNewSetName] = useState("");
  const [selectedSetForRoom, setSelectedSetForRoom] = useState({});
  const [newRoomCode, setNewRoomCode] = useState("");
  const [newRoomSetId, setNewRoomSetId] = useState("");
  const [newRoomMessage, setNewRoomMessage] = useState("");
  const [newRoomPenalty, setNewRoomPenalty] = useState("");
  const [newRoomWrongLimit, setNewRoomWrongLimit] = useState("");
  const [roomMessages, setRoomMessages] = useState({});
  const [roomPenalties, setRoomPenalties] = useState({});
  const [roomWrongLimits, setRoomWrongLimits] = useState({});
  
  // Externí úkoly - používáme jen lokální UI stavy, data bereme z Firebase
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskCode, setTaskCode] = useState("");
  
  // Pevné kódy pro externí úkoly
  const EXTERNAL_TASK_CODES = ["2354", "9156", "4792", "3648", "5937"];

  // UI / volby
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [lockRemaining, setLockRemaining] = useState(0);
  const [showCfg, setShowCfg] = useState(false);
  const [fileInfo, setFileInfo] = useState("");
  const [showOnlyUnsolved, setShowOnlyUnsolved] = useState(false);
  const [displayMode, setDisplayMode] = useState("overlay"); // "popup", "overlay", "inline"
  const [jumpTo, setJumpTo] = useState("");
  const [overlayQuestion, setOverlayQuestion] = useState(null);
  const [overlayResult, setOverlayResult] = useState(null); // null, 'correct', 'wrong'
  const [flash, setFlash] = useState(null);
  
  // Časovač
  const [gameStartTime, setGameStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  // Chat / log
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [answersLog, setAnswersLog] = useState([]);
  const [showLog, setShowLog] = useState(false);

  // Refs
  const chatBoxRef = useRef(null);
  const unsubChatRef = useRef(null);
  const unsubAnswersRef = useRef(null);
  const unsubRoomRef = useRef(null);
  const unsubPlayersRef = useRef(null);
  const lockTimerRef = useRef(null);
  const effectiveQuestionsRef = useRef([]);
  const fanfarePlayedRef = useRef(false); // pro listener z popupu (vyhne se TDZ)

  // Externí úkoly - zjistí, zda je potřeba externí úkol
  const needsExternalTask = useMemo(() => {
    if (!room?.wrongAnswerLimit || room.wrongAnswerLimit <= 0) return false;
    const currentCount = room?.wrongAnswerCount || 0;
    const tasksCompleted = room?.completedTasks || 0;
    
    // Maximálně 5 externích úkolů
    if (tasksCompleted >= 5) return false;
    
    const threshold = room.wrongAnswerLimit; // Vždy stejný threshold pro každý úkol
    const needs = currentCount >= threshold;
    
    // Debug log
    if (room?.wrongAnswerCount !== undefined) {
      console.log(`External task check: count=${currentCount}, completed=${tasksCompleted}, limit=${room.wrongAnswerLimit}, threshold=${threshold}, needs=${needs}, maxReached=${tasksCompleted >= 5}`);
    }
    
    return needs;
  }, [room?.wrongAnswerCount, room?.wrongAnswerLimit, room?.completedTasks]);


  // Načti lokální sadu (fallback nebo uložený import)
  useEffect(() => {
    let active = true;
    const saved = loadSavedQuestions();
    if (saved?.length) {
      setLocalQuestions(saved);
      setFileInfo(`Načteno z uloženého JSONu • ${saved.length} otázek`);
      return () => { active = false; };
    }
    loadQuestionBankDefault().then((qs) => {
      if (!active) return;
      setLocalQuestions(qs);
      setFileInfo(`Výchozí sada • ${qs.length} otázek`);
    });
    return () => { active = false; };
  }, []);
  
  // Načti sady otázek z Firebase při startu
  useEffect(() => {
    if (!configReady) return;
    loadQuestionSetsFromFirebase();
  }, [configReady, activeConfig]);

  // Sleduj globální zámek a počítej odpočet
  useEffect(() => {
    if (!room?.lockedAt) { setLockRemaining(0); return; }
    const tick = () => {
      const startMs = room.lockedAt?.toMillis ? room.lockedAt.toMillis() : room.lockedAt;
      const penaltyMs = (room.penaltySeconds || 10) * 1000;
      const rem = Math.max(0, Math.ceil((startMs + penaltyMs - Date.now()) / 1000));
      setLockRemaining(rem);
    };
    tick();
    clearInterval(lockTimerRef.current);
    lockTimerRef.current = setInterval(tick, 250);
    return () => clearInterval(lockTimerRef.current);
  }, [room?.lockedAt, room?.penaltySeconds]);

  // Odvozené otázky (definuj PŘED listenerem)
  const effectiveQuestions = useMemo(() => {
    const shared = room?.bank?.items;
    if (Array.isArray(shared) && shared.length) return shared;
    // Pokud místnost má přiřazenou sadu, použij ji
    if (room?.questionSetId && questionSets[room.questionSetId]) {
      return questionSets[room.questionSetId].questions || [];
    }
    return localQuestions || [];
  }, [room?.bank?.items, room?.questionSetId, questionSets, localQuestions]);

  // drž vždy aktuální sadu pro handler v popupu
  useEffect(() => { effectiveQuestionsRef.current = effectiveQuestions; }, [effectiveQuestions]);

  const solvedMap = room?.solved || {};
  const solvedCount = Object.keys(solvedMap).length;
  const totalCount = effectiveQuestions.length || 0;
  const allSolved = totalCount > 0 && solvedCount >= totalCount;
  
  
  // Listener pro externí úkoly
  useEffect(() => {
    if (needsExternalTask && !showTaskModal && stage === "game") {
      setShowTaskModal(true);
      setTaskCode("");
    } else if (!needsExternalTask && showTaskModal) {
      // Zavři modal, pokud už není potřeba úkol (někdo jiný ho dokončil)
      setShowTaskModal(false);
      setTaskCode("");
    }
  }, [needsExternalTask, showTaskModal, stage]);
  
  // Jakmile kdokoliv ve stejné místnosti spustí hru, automaticky přepni všechny do GAME a spusť časovač
  useEffect(() => { 
    if (room?.started && stage !== "game") {
      setStage("game");
      
      // Pokud místnost má gameStartedAt, nastav časovač podle toho
      if (room.gameStartedAt) {
        const startMs = room.gameStartedAt?.toMillis ? room.gameStartedAt.toMillis() : room.gameStartedAt;
        setGameStartTime(startMs);
        setIsTimerRunning(true);
        
        // Vypočítej už uplynulý čas
        const now = Date.now();
        const elapsed = Math.floor((now - startMs) / 1000);
        setElapsedTime(elapsed);
      }
    } 
  }, [room?.started, room?.gameStartedAt, stage]);

  // Časovač - aktualizace každou sekundu
  useEffect(() => {
    if (!isTimerRunning || !gameStartTime) return;
    
    // Okamžitá aktualizace
    const now = Date.now();
    const elapsed = Math.floor((now - gameStartTime) / 1000);
    setElapsedTime(elapsed);
    
    // Pravidelné aktualizace
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - gameStartTime) / 1000);
      setElapsedTime(elapsed);
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isTimerRunning, gameStartTime]);
  
  // Pusť fanfáru po dokončení a zastav časovač
  useEffect(() => { 
    if (allSolved && isTimerRunning) {
      playFanfare();
      setIsTimerRunning(false);
      
      // Ulož finální čas
      if (gameStartTime) {
        const finalTime = Math.floor((Date.now() - gameStartTime) / 1000);
        setElapsedTime(finalTime);
      }
    }
  }, [allSolved, isTimerRunning, gameStartTime]);

  // Listener pro pop‑up okna – přijímá odpovědi a vrací výsledek
  useEffect(() => {
    function onMsg(ev) {
      const d = ev?.data || {};
      if (!d || typeof d !== 'object') return;
      if (d.type === 'popup-answer' && Number.isInteger(d.qIndex) && Number.isInteger(d.choice)) {
        submitAnswerFromPopup(d.qIndex, d.choice, ev.source);
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [room?.id, myId, nick]); // neodkazuj na effectiveQuestions – čteme z refu
  
  // Klávesové ovládání pro overlay
  useEffect(() => {
    function handleKeyPress(e) {
      if (overlayQuestion === null) return;
      
      if (e.key === 'Escape') {
        setOverlayQuestion(null);
        setOverlayResult(null);
        return;
      }
      
      // Čísla 1-9 nebo písmena A-I pro odpovědi
      const question = effectiveQuestions[overlayQuestion];
      if (!question || lockRemaining > 0 || needsExternalTask) return;
      
      let answerIndex = -1;
      if (e.key >= '1' && e.key <= '9') {
        answerIndex = parseInt(e.key) - 1;
      } else if (e.key.toUpperCase() >= 'A' && e.key.toUpperCase() <= 'I') {
        answerIndex = e.key.toUpperCase().charCodeAt(0) - 65;
      }
      
      if (answerIndex >= 0 && answerIndex < question.options.length) {
        submitAnswerOverlay(overlayQuestion, answerIndex);
      }
    }
    
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [overlayQuestion, effectiveQuestions, lockRemaining, needsExternalTask]);

  async function submitAnswerFromPopup(qIndex, choice, popwin) {
    try {
      if (!effectiveQuestionsRef.current?.[qIndex] || !room?.id) return;
      const { fs, db } = await getFS(activeConfig);
      const rRef = fs.doc(db, "rooms", normalizeRoom(roomCode));
      const ok = choice === (effectiveQuestionsRef.current[qIndex]?.answer);
      if (ok) {
        try {
          await fs.updateDoc(fs.doc(db, "rooms", normalizeRoom(roomCode), "players", myId), { score: fs.increment(1) });
          const patch = {}; patch[`solved.${qIndex}`] = true; await fs.updateDoc(rRef, patch);
          const cm = (effectiveQuestionsRef.current[qIndex]?.comment || "").trim();
          await fs.addDoc(fs.collection(db, "rooms", normalizeRoom(roomCode), "answers"),
            { qIndex, correct: true, authorId: myId, authorNick: nick, comment: cm || null, ts: fs.serverTimestamp() });
          if (popwin && popwin.postMessage) popwin.postMessage({ type: 'popup-result', qIndex, correct: true, comment: (cm || null) }, '*');
          if (cm) { setFlash(`Hint: ${cm}`); setTimeout(() => setFlash(null), 6000); }
        } catch (e) { console.error(e); }
      } else {
        try {
          await fs.runTransaction(db, async (tx) => {
            const snap = await tx.get(rRef);
            const roomData = snap.data();
            const now = Date.now();
            const lockedAt = roomData?.lockedAt;
            const penaltyMs = (roomData?.penaltySeconds || 10) * 1000;
            const stillLocked = lockedAt && (lockedAt.toMillis ? (lockedAt.toMillis() + penaltyMs > now) : (lockedAt + penaltyMs > now));
            if (!stillLocked) {
              const newWrongCount = (roomData?.wrongAnswerCount || 0) + 1;
              tx.update(rRef, { 
                lockedAt: (await getFS(activeConfig)).fs.serverTimestamp(), 
                lockedBy: nick,
                wrongAnswerCount: newWrongCount
              });
            }
          });
        } catch (e) { console.error("Lock TX failed", e); }
        try {
          await fs.addDoc(fs.collection(db, "rooms", normalizeRoom(roomCode), "answers"),
            { qIndex, correct: false, authorId: myId, authorNick: nick, choice: choice, ts: fs.serverTimestamp() });
        } catch (e) { console.error("Log answer failed", e); }
        if (popwin && popwin.postMessage) popwin.postMessage({ type: 'popup-result', qIndex, correct: false }, '*');
      }
    } catch (e) { console.error(e); }
  }

  async function submitAnswerInline(qIndex, choice) {
    return submitAnswerFromPopup(qIndex, choice, null);
  }
  
  async function submitAnswerOverlay(qIndex, choice) {
    if (!effectiveQuestionsRef.current?.[qIndex] || !room?.id) return;
    
    const correct = choice === (effectiveQuestionsRef.current[qIndex]?.answer);
    
    // Nastav výsledek pro zobrazení v overlay
    setOverlayResult(correct ? 'correct' : 'wrong');
    
    // Proveď standardní submit
    await submitAnswerFromPopup(qIndex, choice, null);
    
    // Pokud je správně, zavři po chvíli
    if (correct) {
      setTimeout(() => {
        setOverlayQuestion(null);
        setOverlayResult(null);
      }, 1500);
    }
  }

  // Odeslání kódu externího úkolu
  async function submitTaskCode() {
    console.log("submitTaskCode called - new version with EXTERNAL_TASK_CODES");
    const code = taskCode.trim();
    if (!code) return;
    
    const taskNumber = (room?.completedTasks || 0) + 1;
    const expectedCode = EXTERNAL_TASK_CODES[taskNumber - 1]; // -1 protože array je 0-indexed
    
    if (code === expectedCode) {
      // Úspěšné ověření - resetuj počítadlo špatných odpovědí
      try {
        const { fs, db } = await getFS(activeConfig);
        const roomRef = fs.doc(db, "rooms", normalizeRoom(roomCode));
        await fs.updateDoc(roomRef, {
          wrongAnswerCount: 0,
          completedTasks: taskNumber
        });
      } catch (e) {
        console.error("Chyba při resetování počítadla:", e);
      }
      
      setShowTaskModal(false);
      setTaskCode("");
      setFlash(`Úkol ${taskNumber} byl dokončen! Můžete pokračovat v kvízu.`);
      setTimeout(() => setFlash(null), 4000);
    } else {
      // Nesprávný kód
      setFlash("Nesprávný kód. Zkuste to znovu.");
      setTimeout(() => setFlash(null), 2000);
      setTaskCode("");
    }
  }

  // Fanfára – přehraj krátkou sekvenci tónů (bez externích souborů)
  function playFanfare(){
    try{
      if (fanfarePlayedRef.current) return;
      fanfarePlayedRef.current = true;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = [
        {f:523.25, t:0.00, d:0.20, g:0.5}, // C5
        {f:659.25, t:0.22, d:0.20, g:0.5}, // E5
        {f:783.99, t:0.44, d:0.25, g:0.5}, // G5
        {f:1046.50,t:0.72, d:0.35, g:0.6}, // C6
      ];
      notes.forEach(n=>{
        const o=ctx.createOscillator(); const g=ctx.createGain();
        o.type='triangle'; o.frequency.setValueAtTime(n.f, now+n.t);
        g.gain.setValueAtTime(0.0001, now+n.t);
        g.gain.exponentialRampToValueAtTime(n.g, now+n.t+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now+n.t+n.d);
        o.connect(g).connect(ctx.destination);
        o.start(now+n.t); o.stop(now+n.t+n.d+0.05);
      });
      setTimeout(()=>{ try{ctx.close();}catch{} }, 2000);
    }catch(e){ /* ignore */ }
  }

  function openQuestionPopup(idx) {
    try {
      if (!effectiveQuestionsRef.current?.[idx]) return;
      const q = effectiveQuestionsRef.current[idx];
      const w = window.open('', `q${idx}-${Date.now()}`, 'width=520,height=720,menubar=no,toolbar=no,location=no,status=no');
      if (!w) { alert('Prohlížeč zablokoval okno. Povolte vyskakovací okna pro tuto stránku.'); return; }
      const esc = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
      const html = `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Otázka #${idx+1}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;padding:16px;background:#f8fafc;color:#0f172a}
  .hdr{font-weight:700;margin-bottom:8px}
  .q{font-size:16px;margin:8px 0 12px}
  .opt{display:block;width:100%;text-align:left;margin:8px 0;padding:10px 12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;cursor:pointer}
  .info{margin-top:12px;font-size:14px}
</style></head><body>
  <div class="hdr">Otázka #${idx+1}</div>
  <div class="q">${esc(q.q)}</div>
  <div id="opts"></div>
  <div id="info" class="info"></div>
<script>
  const qIndex=${idx};
  const options=${JSON.stringify(q.options)};
  function send(choice){ try{ window.opener && window.opener.postMessage({type:'popup-answer', qIndex, choice}, '*'); }catch(e){} }
  const box=document.getElementById('opts');
  options.forEach((t,i)=>{ const b=document.createElement('button'); b.className='opt'; b.textContent=t; b.onclick=()=>{ send(i); Array.from(box.children).forEach(x=>x.disabled=true); }; box.appendChild(b); });
  window.addEventListener('message', (ev)=>{ const d=ev.data||{}; if(d.type==='popup-result' && d.qIndex===qIndex){ const el=document.getElementById('info'); if(d.correct){ el.textContent = d.comment? ('Správně! '+d.comment) : 'Správně!'; setTimeout(()=>{ window.close(); }, 1200); } else { el.textContent = 'Špatně. Pauza 10 s…'; setTimeout(()=>{ el.textContent='Zkuste znovu.'; Array.from(box.children).forEach(x=>x.disabled=false); }, 10000); } }});
</script>
</body></html>`;
      w.document.open(); w.document.write(html); w.document.close();
    } catch (e) { alert('Nepodařilo se otevřít okno: ' + e.message); }
  }

  // Auto‑scroll chatu na poslední zprávu
  useEffect(() => { if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight; }, [chatMessages.length, stage]);

  function saveFirebaseCfg(next) {
    const merged = { ...firebaseCfg, ...next };
    setFirebaseCfg(merged);
    try { localStorage.setItem(LS_FB, JSON.stringify(merged)); } catch {}
  }
  function resetFirebaseCfg() { setFirebaseCfg({ ...firebaseConfigDefaults }); try { localStorage.removeItem(LS_FB); } catch {} }

  // Připojení do místnosti
  async function joinRoom() {
    if (!configReady) { alert("Doplňte prosím Firebase konfiguraci v sekci Nastavení."); setShowCfg(true); return; }
    const { fs, db } = await getFS(activeConfig);
    const code = normalizeRoom(roomCode);
    const nickname = nick.trim().slice(0, 24) || "Player";
    setRoomCode(code); setNick(nickname);
    localStorage.setItem("tqr:room", code); localStorage.setItem("tqr:nick", nickname);
    setLoading(true);
    try {
      const roomRef = fs.doc(db, "rooms", code);
      const snap = await fs.getDoc(roomRef);
      if (!snap.exists()) {
        // Pokud místnost neexistuje, nevytváříme ji automaticky
        alert(`Místnost ${code} neexistuje. Požádejte administrátora o její vytvoření.`);
        setLoading(false);
        return;
      }
      const playerRef = fs.doc(db, "rooms", code, "players", myId);
      await fs.setDoc(playerRef, { nickname, score: 0, joinedAt: fs.serverTimestamp(), lastSeen: fs.serverTimestamp() }, { merge: true });

      // Subscriptions
      unsubRoomRef.current && unsubRoomRef.current();
      unsubPlayersRef.current && unsubPlayersRef.current();
      unsubRoomRef.current = fs.onSnapshot(roomRef, (d) => setRoom({ id: d.id, ...d.data() }));
      unsubPlayersRef.current = fs.onSnapshot(
        fs.query(fs.collection(db, "rooms", code, "players"), fs.orderBy("joinedAt", "asc")),
        (qs) => { const arr = []; qs.forEach((x) => arr.push({ id: x.id, ...x.data() })); setPlayers(arr); }
      );

      // Chat subscription
      unsubChatRef.current && unsubChatRef.current();
      unsubChatRef.current = fs.onSnapshot(
        fs.query(fs.collection(db, "rooms", code, "chat"), fs.orderBy("ts", "asc"), fs.limit(200)),
        (qs) => { const arr = []; qs.forEach((x) => arr.push({ id: x.id, ...x.data() })); setChatMessages(arr); }
      );

      // Answers log subscription
      unsubAnswersRef.current && unsubAnswersRef.current();
      unsubAnswersRef.current = fs.onSnapshot(
        fs.query(fs.collection(db, "rooms", code, "answers"), fs.orderBy("ts", "asc"), fs.limit(1000)),
        (qs) => { const arr = []; qs.forEach((x) => arr.push({ id: x.id, ...x.data() })); setAnswersLog(arr); }
      );
      
      // Načti sady otázek z Firebase
      await loadQuestionSetsFromFirebase();

      // Pokud je hra již spuštěna, přejdi rovnou do hry
      const currentRoomSnap = await fs.getDoc(roomRef);
      if (currentRoomSnap.exists() && currentRoomSnap.data().started) {
        setStage("game");
        
        // Nastav časovač podle uloženého času startu
        const roomData = currentRoomSnap.data();
        if (roomData.gameStartedAt) {
          const startMs = roomData.gameStartedAt?.toMillis ? roomData.gameStartedAt.toMillis() : roomData.gameStartedAt;
          setGameStartTime(startMs);
          setIsTimerRunning(true);
          
          // Vypočítej už uplynulý čas
          const now = Date.now();
          const elapsed = Math.floor((now - startMs) / 1000);
          setElapsedTime(elapsed);
        }
      } else {
        setStage("lobby");
      }
      const presence = setInterval(() => fs.updateDoc(playerRef, { lastSeen: fs.serverTimestamp() }).catch(() => {}), 5000);
      window.addEventListener("beforeunload", () => clearInterval(presence));
    } catch (e) { alert("Chyba připojení: " + e.message); } finally { setLoading(false); }
  }

  // Publikuj sadu otázek do místnosti (používá přiřazenou sadu), poté start
  async function startGame() {
    const { fs, db } = await getFS(activeConfig);
    if (!room) return;
    const roomRef = fs.doc(db, "rooms", room.id);
    try {
      let toPublish = [];
      
      // Pokud místnost má přiřazenou sadu, načti ji z Firebase
      if (room.questionSetId) {
        const setDoc = await fs.getDoc(fs.doc(db, "questionSets", room.questionSetId));
        if (setDoc.exists()) {
          const setData = setDoc.data();
          toPublish = setData.questions || [];
        }
      }
      
      // Fallback na lokální otázky
      if (!toPublish.length) {
        toPublish = Array.isArray(localQuestions) && localQuestions.length ? localQuestions : FALLBACK_QUESTIONS;
      }
      
      // Ulož čas startu do Firebase a spusť lokální časovač
      await fs.updateDoc(roomRef, { 
        bank: { items: toPublish }, 
        solved: {}, 
        gameStartedAt: fs.serverTimestamp() 
      });
      await fs.updateDoc(roomRef, { started: true });
      
      // Nastav lokální časovač
      const now = Date.now();
      setGameStartTime(now);
      setElapsedTime(0);
      setIsTimerRunning(true);
      setStage("game");
    } catch (e) { alert("Nelze spustit: " + e.message); }
  }

  // Odeslání zprávy v chatu
  async function sendChat() {
    try {
      const text = (chatInput || "").trim();
      if (!text || !room?.id) return;
      const { fs, db } = await getFS(activeConfig);
      await fs.addDoc(fs.collection(db, "rooms", room.id, "chat"), { text, authorId: myId, authorNick: nick, ts: fs.serverTimestamp() });
      setChatInput("");
    } catch (e) { alert("Nelze odeslat: " + e.message); }
  }

  // Skok na číslo otázky
  function doJump() {
    const n = parseInt(jumpTo, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= (effectiveQuestions?.length || 0)) {
      const idx = n - 1; if (!solvedMap[idx]) setSelectedIndex(idx);
    }
  }

  const canStart = players.length >= 2 && !room?.started;
  
  // Admin funkce
  async function handleAdminLogin() {
    if (adminPassword === "8288") {
      setIsAdmin(true);
      setShowAdminLogin(false);
      setAdminPassword("");
      setStage("admin");
      await loadAllRooms();
    } else {
      alert("Nesprávné heslo");
      setAdminPassword("");
    }
  }
  
  async function loadAllRooms() {
    if (!configReady) return;
    try {
      const { fs, db } = await getFS(activeConfig);
      const roomsQuery = fs.query(fs.collection(db, "rooms"));
      const snapshot = await fs.getDocs(roomsQuery);
      const rooms = [];
      snapshot.forEach(doc => {
        rooms.push({ id: doc.id, ...doc.data() });
      });
      setAllRooms(rooms);
      
      // Načti také sady otázek
      await loadQuestionSetsFromFirebase();
    } catch (e) {
      alert("Chyba při načítání místností: " + e.message);
    }
  }
  
  async function loadQuestionSetsFromFirebase() {
    if (!configReady) return;
    try {
      const { fs, db } = await getFS(activeConfig);
      const setsSnapshot = await fs.getDocs(fs.collection(db, "questionSets"));
      const sets = {};
      setsSnapshot.forEach(doc => {
        sets[doc.id] = doc.data();
      });
      setQuestionSets(sets);
    } catch (e) {
      console.error("Chyba při načítání sad otázek:", e);
    }
  }
  
  async function deleteRoom(roomId) {
    if (!confirm(`Opravdu chcete smazat místnost ${roomId} včetně všech dat?`)) return;
    try {
      const { fs, db } = await getFS(activeConfig);
      
      // Smaž všechny hráče
      const playersQuery = fs.query(fs.collection(db, "rooms", roomId, "players"));
      const playersSnapshot = await fs.getDocs(playersQuery);
      for (const doc of playersSnapshot.docs) {
        await fs.deleteDoc(doc.ref);
      }
      
      // Smaž všechny chat zprávy
      const chatQuery = fs.query(fs.collection(db, "rooms", roomId, "chat"));
      const chatSnapshot = await fs.getDocs(chatQuery);
      for (const doc of chatSnapshot.docs) {
        await fs.deleteDoc(doc.ref);
      }
      
      // Smaž všechny odpovědi
      const answersQuery = fs.query(fs.collection(db, "rooms", roomId, "answers"));
      const answersSnapshot = await fs.getDocs(answersQuery);
      for (const doc of answersSnapshot.docs) {
        await fs.deleteDoc(doc.ref);
      }
      
      // Smaž samotnou místnost
      await fs.deleteDoc(fs.doc(db, "rooms", roomId));
      
      alert(`Místnost ${roomId} byla úspěšně smazána`);
      await loadAllRooms();
    } catch (e) {
      alert("Chyba při mazání místnosti: " + e.message);
    }
  }
  
  async function assignSetToRoom(roomId, setId) {
    if (!setId) return;
    try {
      const { fs, db } = await getFS(activeConfig);
      const updates = { questionSetId: setId };
      
      // Pokud je zadána nová hláška pro tuto místnost, ulož ji také
      if (roomMessages[roomId] !== undefined) {
        updates.completionMessage = roomMessages[roomId].trim() || "Kód Vaší mise je 2289";
      }
      
      // Pokud je zadána nová penalizace pro tuto místnost, ulož ji také
      if (roomPenalties[roomId] !== undefined) {
        updates.penaltySeconds = parseInt(roomPenalties[roomId]) || 10;
      }
      
      // Pokud je zadán nový limit špatných odpovědí, ulož ho také
      if (roomWrongLimits[roomId] !== undefined) {
        updates.wrongAnswerLimit = parseInt(roomWrongLimits[roomId]) || 0;
      }
      
      await fs.updateDoc(fs.doc(db, "rooms", roomId), updates);
      setSelectedSetForRoom({ ...selectedSetForRoom, [roomId]: setId });
      alert(`Sada a nastavení byly přiřazeny místnosti ${roomId}`);
      await loadAllRooms();
    } catch (e) {
      alert("Chyba při přiřazení sady: " + e.message);
    }
  }
  
  async function addQuestionSet() {
    if (!newSetName.trim()) return;
    if (!localQuestions?.length) {
      alert("Nejprve nahrajte JSON s otázkami");
      return;
    }
    
    try {
      const { fs, db } = await getFS(activeConfig);
      const setId = uid();
      const newSet = {
        name: newSetName.trim(),
        questions: localQuestions,
        createdAt: fs.serverTimestamp()
      };
      
      // Ulož do Firebase
      await fs.setDoc(fs.doc(db, "questionSets", setId), newSet);
      
      // Aktualizuj lokální stav
      setQuestionSets({ ...questionSets, [setId]: newSet });
      setNewSetName("");
      setFileInfo(`Sada "${newSet.name}" byla přidána`);
    } catch (e) {
      alert("Chyba při ukládání sady: " + e.message);
    }
  }
  
  async function deleteQuestionSet(setId) {
    if (!confirm(`Opravdu chcete smazat tuto sadu otázek?`)) return;
    
    try {
      const { fs, db } = await getFS(activeConfig);
      await fs.deleteDoc(fs.doc(db, "questionSets", setId));
      
      // Aktualizuj lokální stav
      const newSets = { ...questionSets };
      delete newSets[setId];
      setQuestionSets(newSets);
    } catch (e) {
      alert("Chyba při mazání sady: " + e.message);
    }
  }
  
  
  async function createRoom() {
    if (!newRoomCode.trim()) {
      alert("Zadejte kód místnosti");
      return;
    }
    if (!newRoomSetId) {
      alert("Vyberte sadu otázek");
      return;
    }
    
    try {
      const { fs, db } = await getFS(activeConfig);
      const code = normalizeRoom(newRoomCode);
      const roomRef = fs.doc(db, "rooms", code);
      
      // Kontrola, zda místnost již existuje
      const snap = await fs.getDoc(roomRef);
      if (snap.exists()) {
        alert(`Místnost ${code} již existuje`);
        return;
      }
      
      // Vytvoření nové místnosti s přiřazenou sadou, hláškou, penalizací a limitem špatných odpovědí
      await fs.setDoc(roomRef, {
        createdAt: fs.serverTimestamp(),
        started: false,
        lockedAt: null,
        lockedBy: "",
        bank: null,
        solved: {},
        questionSetId: newRoomSetId,
        completionMessage: newRoomMessage.trim() || "Kód Vaší mise je 2289",
        penaltySeconds: parseInt(newRoomPenalty) || 10,
        wrongAnswerLimit: parseInt(newRoomWrongLimit) || 0,
        wrongAnswerCount: 0,
        completedTasks: 0
      });
      
      alert(`Místnost ${code} byla vytvořena se sadou otázek`);
      setNewRoomCode("");
      setNewRoomSetId("");
      setNewRoomMessage("");
      setNewRoomPenalty("");
      setNewRoomWrongLimit("");
      await loadAllRooms();
    } catch (e) {
      alert("Chyba při vytváření místnosti: " + e.message);
    }
  }

  // === UI ===
  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-4 sm:p-6">
      <div className="max-w-6xl mx-auto">
        <style>{`
          :root{ color-scheme: light; }
          input, textarea, select{ background:#fff !important; color:#0f172a !important; }
          input::placeholder, textarea::placeholder{ color:#64748b !important; }
          input:-webkit-autofill, textarea:-webkit-autofill, select:-webkit-autofill{ -webkit-text-fill-color:#0f172a !important; box-shadow: 0 0 0px 1000px #fff inset !important; }
          button.quiz-num{ display:flex; align-items:center; justify-content:center; }
          .mission-banner{animation:blink .9s steps(2,start) infinite; box-shadow:0 0 0 4px rgba(16,185,129,.25), 0 0 30px rgba(16,185,129,.35)}
          @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
          @media (prefers-reduced-motion: reduce){.mission-banner{animation:none}}
        `}</style>
        <header className="mb-6 flex items-center justify-between">
          {flash && (
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[90%] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl shadow px-4 py-3 text-sm">{flash}</div>
          )}
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Síťový týmový kvíz</h1>
            <p className="text-slate-600 text-sm">Týmový režim • kvíz končí po vyřešení všech otázek • špatná odpověď = penalizace</p>
          </div>
          {room && (
            <div className="text-right text-sm">
              <div className="font-mono">Místnost: <span className="px-2 py-0.5 rounded bg-slate-200">{room.id}</span></div>
              <div>Vy: <span className="font-semibold">{nick || ""}</span></div>
              {stage === "game" && (
                <div className="mt-1">
                  <div className="font-mono text-lg">
                    ⏱️ <span className={classNames("font-bold", isTimerRunning ? "text-blue-600" : allSolved ? "text-emerald-600" : "text-slate-600")}>
                      {formatTime(elapsedTime)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {allSolved ? "Dokončeno!" : isTimerRunning ? "Běží..." : "Čeká"}
                  </div>
                </div>
              )}
            </div>
          )}
        </header>

        {stage === "intro" && (
          <div className="bg-white rounded-2xl shadow p-6 grid gap-4">
            <div className="grid gap-2">
              <label className="text-sm text-slate-600">Kód místnosti (A–Z, 0–9):</label>
              <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} className="border rounded-xl px-4 py-3 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Např. DEVOPS" />
              <div className="text-xs text-amber-600">⚠️ Místnosti musí být vytvořeny administrátorem pro správné přiřazení sady otázek</div>
            </div>
            <div className="grid gap-2">
              <label className="text-sm text-slate-600">Váš nickname:</label>
              <input value={nick} onChange={(e) => setNick(e.target.value)} className="border rounded-xl px-4 py-3 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Např. AnsibleKing" />
            </div>



            <div className="flex gap-3 justify-between">
              <button onClick={() => setShowAdminLogin(true)} className="px-4 py-3 rounded-2xl bg-amber-600 hover:bg-amber-500 text-white">Admin</button>
              <button disabled={!configReady || !roomCode || !nick || loading} onClick={joinRoom} className={classNames("px-4 py-3 rounded-2xl text-white", (!configReady || !roomCode || !nick || loading) ? "bg-slate-400" : "bg-slate-900 hover:bg-slate-800")}>{loading ? "Připojuji…" : "Připojit"}</button>
            </div>
            
            {/* Admin login modal */}
            {showAdminLogin && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-white rounded-2xl p-6 max-w-sm w-[90%]">
                  <h3 className="text-lg font-semibold mb-4">Admin přihlášení</h3>
                  <input 
                    type="password" 
                    value={adminPassword} 
                    onChange={(e) => setAdminPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdminLogin()}
                    className="w-full border rounded-xl px-3 py-2 mb-4"
                    placeholder="Zadejte heslo"
                    autoFocus
                  />
                  <div className="flex gap-3 justify-end">
                    <button onClick={() => { setShowAdminLogin(false); setAdminPassword(""); }} className="px-4 py-2 rounded-xl bg-slate-200">Zrušit</button>
                    <button onClick={handleAdminLogin} className="px-4 py-2 rounded-xl bg-amber-600 text-white">Přihlásit</button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {stage === "lobby" && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded-2xl shadow p-6">
              <h3 className="font-semibold mb-2">Hráči</h3>
              <div className="flex flex-wrap gap-2">
                {players.map((p) => (
                  <span key={p.id} className="px-3 py-1 rounded-full bg-slate-100 border">{p.nickname}</span>
                ))}
              </div>
              <div className="mt-3 text-sm text-slate-600">
                {room?.questionSetId && questionSets[room.questionSetId] ? (
                  <>Přiřazená sada: <strong>{questionSets[room.questionSetId].name}</strong> ({questionSets[room.questionSetId].questions?.length} otázek)</>
                ) : (
                  <>Sada k publikaci: <strong>{(Array.isArray(localQuestions) && localQuestions.length ? localQuestions.length : FALLBACK_QUESTIONS.length)}</strong> otázek</>
                )}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button disabled={!canStart} onClick={startGame} className={classNames("px-4 py-2 rounded-2xl text-white", canStart ? "bg-emerald-600 hover:bg-emerald-500" : "bg-slate-400")}>⏱️ Start (spustí časovač)</button>
                {!canStart && <span className="text-sm text-slate-500">Potřeba alespoň 2 hráči a nezahájená hra.</span>}
              </div>
            </div>
            <div className="bg-white rounded-2xl shadow p-6">
              <h3 className="font-semibold mb-2">Chat</h3>
              <div ref={chatBoxRef} className="h-64 overflow-auto border rounded-xl p-3 bg-slate-50">
                {chatMessages.map((m) => (
                  <div key={m.id} className="text-sm mb-1"><span className="font-semibold">{m.authorNick}:</span> {m.text}</div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} className="border rounded-xl px-3 py-2 flex-1 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Napiš zprávu…" />
                <button onClick={sendChat} className="px-3 py-2 rounded-xl bg-slate-900 text-white">Odeslat</button>
              </div>
            </div>
          </div>
        )}

        {stage === "game" && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded-2xl shadow p-6">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" className="accent-slate-900" checked={showOnlyUnsolved} onChange={(e) => setShowOnlyUnsolved(e.target.checked)} />
                  Jen nevyřešené
                </label>
                <div className="flex items-center gap-4">
                  <label className="text-sm text-slate-600">Režim zobrazení otázek:</label>
                  <select 
                    value={displayMode} 
                    onChange={(e) => setDisplayMode(e.target.value)}
                    className="border rounded-lg px-2 py-1 text-sm"
                  >
                    <option value="popup">Nové okno (popup)</option>
                    <option value="overlay">Přes celou obrazovku</option>
                    <option value="inline">V hlavním okně</option>
                  </select>
                </div>
                <div className="ml-auto flex items-center gap-2 text-sm">
                  <span>Skok na #</span>
                  <input value={jumpTo} onChange={(e) => setJumpTo(e.target.value)} className="border rounded-lg px-2 py-1 w-20 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" />
                  <button onClick={doJump} className="px-3 py-1 rounded-lg bg-slate-100 border">Jít</button>
                </div>
              </div>

              {/* Lock overlay */}
              {lockRemaining > 0 && (
                <div className="mb-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                  Pauza {lockRemaining}s – způsobil: <strong>{room?.lockedBy || "neznámý"}</strong>
                </div>
              )}

              {/* External task warning */}
              {needsExternalTask && (
                <div className="mb-3 px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-900 text-sm">
                  <strong>🚨 Externí úkol #{(room?.completedTasks || 0) + 1} je vyžadován!</strong><br />
                  Kvíz je blokován do dokončení úkolu. Počet špatných odpovědí: {room?.wrongAnswerCount || 0}
                </div>
              )}

              {/* Grid otázek */}
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(2.5rem,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(2.75rem,1fr))]">
                {effectiveQuestions.map((q, i) => {
                  const done = !!solvedMap[i];
                  if (showOnlyUnsolved && done) return null;
                  return (
                    <button key={i} disabled={lockRemaining > 0 || needsExternalTask}
                      className={classNames(
                        "aspect-square w-full rounded-lg border text-sm font-medium flex items-center justify-center quiz-num",
                        done ? "bg-emerald-50 border-emerald-200 text-emerald-700" : 
                        needsExternalTask ? "bg-red-50 border-red-200 text-red-600" :
                        "bg-white border-slate-200 hover:bg-slate-50",
                        (lockRemaining > 0 || needsExternalTask) && "opacity-60 cursor-not-allowed"
                      )}
                      onClick={() => {
                        if (needsExternalTask) return;
                        if (displayMode === "popup") {
                          openQuestionPopup(i);
                        } else if (displayMode === "overlay") {
                          setOverlayQuestion(i);
                        } else {
                          setSelectedIndex(i);
                        }
                      }}
                      title={needsExternalTask ? "Dokončete externí úkol" : q.q}
                    >{i + 1}</button>
                  );
                })}
              </div>

              {/* Inline panel otázek (když je inline režim) */}
              {displayMode === "inline" && selectedIndex != null && effectiveQuestions[selectedIndex] && !needsExternalTask && (
                <div className="mt-5 border rounded-2xl p-4">
                  <div className="text-sm text-slate-500 mb-1">Otázka #{selectedIndex + 1}</div>
                  <div className="font-medium mb-3">{effectiveQuestions[selectedIndex].q}</div>
                  <div className="grid gap-2">
                    {effectiveQuestions[selectedIndex].options.map((t, idx) => (
                      <button key={idx} disabled={lockRemaining > 0 || needsExternalTask}
                        onClick={() => submitAnswerInline(selectedIndex, idx)}
                        className={classNames("text-left px-3 py-2 rounded-xl border",
                          (lockRemaining > 0 || needsExternalTask) ? "bg-slate-100 cursor-not-allowed" : "bg-white hover:bg-slate-50")}
                      >{t}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Stav */}
              <div className="mt-5 text-sm text-slate-600">
                Vyřešeno: <strong>{solvedCount}/{totalCount}</strong>
                {allSolved && (
                  <div className="mission-banner mt-3 w-full text-center bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">
                    <div className="text-2xl sm:text-4xl font-extrabold tracking-wide text-emerald-800 mb-2">
                      {room?.completionMessage || "Kód Vaší mise je 2289"}
                    </div>
                    <div className="text-lg font-semibold text-emerald-700">
                      🏆 Dokončeno za: {formatTime(elapsedTime)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Chat + log */}
            <div className="bg-white rounded-2xl shadow p-6">
              <h3 className="font-semibold mb-2">Chat</h3>
              <div ref={chatBoxRef} className="h-56 overflow-auto border rounded-xl p-3 bg-slate-50">
                {chatMessages.map((m) => (
                  <div key={m.id} className="text-sm mb-1"><span className="font-semibold">{m.authorNick}:</span> {m.text}</div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} className="border rounded-xl px-3 py-2 flex-1 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Napiš zprávu…" />
                <button onClick={sendChat} className="px-3 py-2 rounded-xl bg-slate-900 text-white">Odeslat</button>
              </div>

              <div className="mt-6 flex items-center justify-between">
                <h4 className="font-semibold">Log odpovědí</h4>
                <button disabled={!allSolved} onClick={() => setShowLog((s) => !s)} className={classNames("px-3 py-1 rounded-lg border", allSolved ? "bg-slate-100" : "bg-slate-100 opacity-50 cursor-not-allowed")}>{showLog ? "Skrýt" : "Zobrazit"}</button>
              </div>
              {showLog && (
                <div className="mt-2 h-48 overflow-auto border rounded-xl p-3 bg-slate-50 text-sm">
                  {answersLog.length === 0 && <div className="text-slate-500">(zatím prázdné)</div>}
                  {answersLog.map((a) => (
                    <div key={a.id} className="py-1 border-b border-slate-200/60 last:border-none">
                      <div><strong>#{(a.qIndex ?? 0) + 1}</strong> – {a.correct ? "správně" : "špatně"} – {a.authorNick}</div>
                      {a.comment && <div className="text-slate-600">Hint: {a.comment}</div>}
                      <div className="text-xs text-slate-500">{a.ts?.toDate ? a.ts.toDate().toLocaleString() : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {stage === "admin" && (
          <div className="bg-white rounded-2xl shadow p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold">Admin sekce</h2>
              <button onClick={() => setStage("intro")} className="px-4 py-2 rounded-xl bg-slate-200">Zpět</button>
            </div>
            
            {/* Správa místností */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold mb-4">Správa místností</h3>
              
              {/* Vytvoření nové místnosti */}
              <div className="border rounded-xl p-4 mb-4 bg-emerald-50">
                <div className="mb-3">
                  <label className="text-sm text-slate-600 font-semibold">Vytvořit novou místnost:</label>
                </div>
                <div className="grid gap-3">
                  <div className="flex gap-3">
                    <input 
                      value={newRoomCode}
                      onChange={(e) => setNewRoomCode(e.target.value.toUpperCase())}
                      className="flex-1 border rounded-xl px-3 py-2"
                      placeholder="Kód místnosti (např. QUIZ123)"
                    />
                    <select 
                      value={newRoomSetId}
                      onChange={(e) => setNewRoomSetId(e.target.value)}
                      className="flex-1 border rounded-xl px-3 py-2"
                    >
                      <option value="">-- Vyberte sadu otázek --</option>
                      {Object.entries(questionSets).map(([setId, setData]) => (
                        <option key={setId} value={setId}>{setData.name} ({setData.questions?.length} otázek)</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-3">
                    <input 
                      value={newRoomMessage}
                      onChange={(e) => setNewRoomMessage(e.target.value)}
                      className="flex-1 border rounded-xl px-3 py-2"
                      placeholder="Hláška po dokončení kvízu (nepovinné)"
                    />
                    <input 
                      type="number"
                      min="1"
                      max="300"
                      value={newRoomPenalty}
                      onChange={(e) => setNewRoomPenalty(e.target.value)}
                      className="w-24 border rounded-xl px-3 py-2"
                      placeholder="10"
                      title="Penalizace v sekundách za špatnou odpověď"
                    />
                    <label className="text-sm text-slate-600 flex items-center whitespace-nowrap">
                      s pauza
                    </label>
                    <input 
                      type="number"
                      min="0"
                      max="50"
                      value={newRoomWrongLimit}
                      onChange={(e) => setNewRoomWrongLimit(e.target.value)}
                      className="w-24 border rounded-xl px-3 py-2"
                      placeholder="0"
                      title="Po kolika špatných odpovědích vyžadovat externí úkol (0 = vypnuto)"
                    />
                    <label className="text-sm text-slate-600 flex items-center whitespace-nowrap">
                      špatných = úkol
                    </label>
                    <button 
                      onClick={createRoom}
                      disabled={!newRoomCode.trim() || !newRoomSetId}
                      className={classNames("px-4 py-2 rounded-xl text-white", 
                        (!newRoomCode.trim() || !newRoomSetId) ? "bg-slate-400" : "bg-emerald-600 hover:bg-emerald-500")}
                    >
                      Vytvořit místnost
                    </button>
                  </div>
                </div>
              </div>
              
              <button 
                onClick={loadAllRooms} 
                className="mb-4 px-4 py-2 rounded-xl bg-slate-200"
              >
                Obnovit seznam
              </button>
              
              <div className="space-y-3">
                {allRooms.map((room) => (
                  <div key={room.id} className="border rounded-xl p-4">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="font-mono text-lg">{room.id}</div>
                        <div className="text-sm text-slate-500">
                          Stav: {room.started ? "Zahájena" : "Čeká"} • 
                          Vyřešeno: {Object.keys(room.solved || {}).length} otázek
                        </div>
                        {room.questionSetId && questionSets[room.questionSetId] && (
                          <div className="text-sm text-emerald-600 mt-1">
                            Přiřazená sada: {questionSets[room.questionSetId].name}
                          </div>
                        )}
                        {room.completionMessage && (
                          <div className="text-sm text-blue-600 mt-1">
                            Hláška po dokončení: "{room.completionMessage}"
                          </div>
                        )}
                        <div className="text-sm text-purple-600 mt-1">
                          Penalizace: {room.penaltySeconds || 10} sekund
                        </div>
                        <div className="text-sm text-orange-600 mt-1">
                          Externí úkol po: {room.wrongAnswerLimit || 0} špatných odpovědích {room.wrongAnswerLimit ? `(${room.wrongAnswerCount || 0}/${room.wrongAnswerLimit})` : "(vypnuto)"}
                        </div>
                      </div>
                      <button 
                        onClick={() => deleteRoom(room.id)}
                        className="px-3 py-1 rounded-lg bg-rose-50 border border-rose-200 text-rose-700"
                      >
                        Smazat místnost
                      </button>
                    </div>
                    
                    {/* Přiřazení sady otázek a hlášky */}
                    <div className="space-y-2">
                      <div className="flex gap-2 items-center">
                        <select 
                          value={selectedSetForRoom[room.id] || room.questionSetId || ""}
                          onChange={(e) => setSelectedSetForRoom({ ...selectedSetForRoom, [room.id]: e.target.value })}
                          className="flex-1 border rounded-lg px-3 py-1"
                        >
                          <option value="">-- Vyberte sadu otázek --</option>
                          {Object.entries(questionSets).map(([setId, setData]) => (
                            <option key={setId} value={setId}>{setData.name} ({setData.questions?.length} otázek)</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2 items-center">
                        <input 
                          value={roomMessages[room.id] !== undefined ? roomMessages[room.id] : room.completionMessage || ""}
                          onChange={(e) => setRoomMessages({ ...roomMessages, [room.id]: e.target.value })}
                          className="flex-1 border rounded-lg px-3 py-1"
                          placeholder="Hláška po dokončení"
                        />
                        <input 
                          type="number"
                          min="1"
                          max="300"
                          value={roomPenalties[room.id] !== undefined ? roomPenalties[room.id] : room.penaltySeconds || 10}
                          onChange={(e) => setRoomPenalties({ ...roomPenalties, [room.id]: e.target.value })}
                          className="w-20 border rounded-lg px-2 py-1"
                          title="Penalizace v sekundách"
                        />
                        <span className="text-sm text-slate-600">s</span>
                        <input 
                          type="number"
                          min="0"
                          max="50"
                          value={roomWrongLimits[room.id] !== undefined ? roomWrongLimits[room.id] : room.wrongAnswerLimit || 0}
                          onChange={(e) => setRoomWrongLimits({ ...roomWrongLimits, [room.id]: e.target.value })}
                          className="w-16 border rounded-lg px-2 py-1"
                          title="Externí úkol po X špatných odpovědích"
                        />
                        <span className="text-sm text-slate-600">šp.=úkol</span>
                        <button 
                          onClick={() => assignSetToRoom(room.id, selectedSetForRoom[room.id] || room.questionSetId)}
                          disabled={!selectedSetForRoom[room.id] && !room.questionSetId}
                          className={classNames("px-3 py-1 rounded-lg", 
                            (!selectedSetForRoom[room.id] && !room.questionSetId) ? "bg-slate-200 text-slate-400" : "bg-emerald-600 text-white")}
                        >
                          Uložit změny
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                
                {allRooms.length === 0 && (
                  <div className="text-center text-slate-500 py-8">
                    Žádné místnosti nebyly nalezeny
                  </div>
                )}
              </div>
            </div>

            {/* Správa sad otázek */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold mb-4">Správa sad otázek</h3>
              
              {/* Přidání nové sady */}
              <div className="border rounded-xl p-4 mb-4 bg-slate-50">
                <div className="mb-3">
                  <label className="text-sm text-slate-600">Importovat otázky do nové sady:</label>
                  <input type="file" accept="application/json" onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return;
                    try { 
                      const qs = await loadQuestionBankFromFile(f); 
                      setLocalQuestions(qs); 
                      setFileInfo(`Načteno: ${f.name} • ${qs.length} otázek`); 
                    }
                    catch (err) { alert(String(err?.message || err)); }
                  }} className="mt-2" />
                </div>
                
                <div className="flex gap-3">
                  <input 
                    value={newSetName}
                    onChange={(e) => setNewSetName(e.target.value)}
                    className="flex-1 border rounded-xl px-3 py-2"
                    placeholder="Název nové sady"
                  />
                  <button 
                    onClick={addQuestionSet}
                    disabled={!newSetName.trim() || !localQuestions?.length}
                    className={classNames("px-4 py-2 rounded-xl text-white", 
                      (!newSetName.trim() || !localQuestions?.length) ? "bg-slate-400" : "bg-emerald-600 hover:bg-emerald-500")}
                  >
                    Přidat sadu
                  </button>
                </div>
                {fileInfo && <div className="text-sm text-slate-500 mt-2">{fileInfo}</div>}
              </div>
              
              {/* Seznam sad */}
              <div className="space-y-2">
                {Object.entries(questionSets).map(([setId, setData]) => (
                  <div key={setId} className="border rounded-xl p-3 flex justify-between items-center">
                    <div>
                      <div className="font-medium">{setData.name}</div>
                      <div className="text-sm text-slate-500">{setData.questions?.length || 0} otázek</div>
                    </div>
                    <button 
                      onClick={() => deleteQuestionSet(setId)}
                      className="px-3 py-1 rounded-lg bg-rose-50 border border-rose-200 text-rose-700"
                    >
                      Smazat
                    </button>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Testovací import otázek */}
            <div className="mb-8">
              <details className="border rounded-2xl p-4 bg-amber-50">
                <summary className="cursor-pointer font-semibold">Testovací import otázek (pouze pro ladění)</summary>
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-500">{fileInfo}</span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                    <input type="file" accept="application/json" onChange={async (e) => {
                      const f = e.target.files?.[0]; if (!f) return;
                      try { const qs = await loadQuestionBankFromFile(f); setLocalQuestions(qs); saveQuestionsToLS(qs); setFileInfo(`Soubor: ${f.name} • ${qs.length} otázek`); }
                      catch (err) { alert(String(err?.message || err)); }
                    }} />
                    <button className="px-3 py-2 rounded-xl bg-slate-100 border" onClick={() => { clearSavedQuestions(); setFileInfo("Vymazáno"); }}>Vymazat uloženou sadu</button>
                  </div>
                  <div className="text-xs text-amber-600 mt-2">⚠️ Toto je pouze pro testování - používejte sekci "Správa sad otázek" výše</div>
                </div>
              </details>
            </div>
            
            {/* Nastavení Firebase */}
            <div className="mb-8">
              <div className="border rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Nastavení Firebase</h3>
                  {(cfgLockedByFile || cfgLockedByStatic) && (
                    <span className="text-xs text-slate-500">Konfigurace je uzamčena souborem nebo staticky v kódu.</span>
                  )}
                </div>
                {!cfgLockedByFile && !cfgLockedByStatic && (
                  <div className="grid sm:grid-cols-2 gap-3 mt-3">
                    {Object.entries(firebaseCfg).map(([k, v]) => (
                      <input key={k} value={v} onChange={(e) => saveFirebaseCfg({ [k]: e.target.value })} className="border rounded-xl px-3 py-2 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder={k} />
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-3">
                  <button className="px-3 py-2 rounded-xl bg-slate-100 border" onClick={() => setShowCfg((s) => !s)}>{showCfg ? "Skrýt JSON" : "Zobrazit JSON"}</button>
                  {!cfgLockedByFile && !cfgLockedByStatic && (
                    <button className="px-3 py-2 rounded-xl bg-rose-50 border border-rose-200" onClick={resetFirebaseCfg}>Resetovat pole</button>
                  )}
                </div>
                {showCfg && (
                  <pre className="mt-3 text-xs bg-slate-50 p-3 rounded-xl overflow-auto">{JSON.stringify(activeConfig, null, 2)}</pre>
                )}
              </div>
            </div>
            
          </div>
        )}
        
        {/* Fullscreen overlay pro otázky */}
        {overlayQuestion !== null && effectiveQuestions[overlayQuestion] && !needsExternalTask && (
          <div className="fixed inset-0 bg-slate-900/95 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-auto">
              <div className="p-6 sm:p-8">
                <div className="flex justify-between items-start mb-6">
                  <div className="text-lg font-bold text-slate-700">
                    Otázka #{overlayQuestion + 1}
                  </div>
                  <button 
                    onClick={() => {
                      setOverlayQuestion(null);
                      setOverlayResult(null);
                    }}
                    className="px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700"
                  >
                    ✕ Zavřít
                  </button>
                </div>
                
                <div className="mb-8">
                  <div className="text-xl sm:text-2xl font-medium text-slate-900 leading-relaxed">
                    {effectiveQuestions[overlayQuestion].q}
                  </div>
                </div>
                
                <div className="grid gap-4">
                  {effectiveQuestions[overlayQuestion].options.map((option, idx) => (
                    <button 
                      key={idx}
                      disabled={lockRemaining > 0 || needsExternalTask}
                      onClick={() => {
                        if (!needsExternalTask) {
                          submitAnswerOverlay(overlayQuestion, idx);
                        }
                      }}
                      className={classNames(
                        "text-left px-6 py-4 rounded-xl border-2 text-lg transition-all",
                        (lockRemaining > 0 || needsExternalTask)
                          ? "bg-slate-100 cursor-not-allowed border-slate-200" 
                          : "bg-white hover:bg-slate-50 border-slate-200 hover:border-slate-400 hover:shadow-md"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center font-semibold text-slate-700">
                          {String.fromCharCode(65 + idx)}
                        </div>
                        <div>{option}</div>
                      </div>
                    </button>
                  ))}
                </div>
                
                {overlayResult === 'correct' && (
                  <div className="mt-6 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-center font-semibold">
                    ✅ Správně! Zavírá se za chvíli...
                    {effectiveQuestions[overlayQuestion]?.comment && (
                      <div className="mt-2 text-sm">{effectiveQuestions[overlayQuestion].comment}</div>
                    )}
                  </div>
                )}
                
                
                {lockRemaining > 0 && (
                  <div className="mt-6 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-center">
                    Pauza {lockRemaining}s – způsobil: <strong>{room?.lockedBy || "neznámý"}</strong>
                    {overlayResult === 'wrong' && (
                      <div className="mt-2 text-sm">Po uplynutí pauzy můžete odpovídat znovu.</div>
                    )}
                  </div>
                )}
                
                <div className="mt-6 pt-4 border-t border-slate-200 text-center text-sm text-slate-500">
                  💡 Tip: Odpovězte klávesami A, B, C, D nebo 1, 2, 3, 4 • ESC pro zavření
                </div>
              </div>
            </div>
          </div>
        )}

        {/* External task modal - zobrazí se v jakémkoliv stage */}
        {showTaskModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl p-6 max-w-sm w-[90%]">
              <h3 className="text-xl font-bold mb-2 text-red-600">
                🚨 Úkol číslo {(room?.completedTasks || 0) + 1} 
                {(room?.completedTasks || 0) === 0 && " (7823)"}
              </h3>
              <p className="text-sm text-slate-600 mb-4">
                Váš tým má příliš mnoho špatných odpovědí ({room?.wrongAnswerCount || 0}). 
                Dokončete externí úkol zadáním správného kódu.
              </p>
              <input 
                type="text" 
                value={taskCode} 
                onChange={(e) => setTaskCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitTaskCode()}
                className="w-full border rounded-xl px-3 py-2 mb-4"
                placeholder="Zadejte 4-místný kód"
                autoFocus
              />
              <div className="flex gap-3 justify-end">
                <button onClick={submitTaskCode} className="px-4 py-2 rounded-xl bg-red-600 text-white">
                  Potvrdit kód
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
