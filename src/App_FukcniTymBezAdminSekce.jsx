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
const PENALTY_MS = 10_000; // 10s globální zámek
const LS_FB = "tqr:fbconfig";
const LS_QS = "tqr:questions"; // uložená lokální sada (z importu)

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizeRoom(code) {
  return (code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "QUIZ";
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
  const [stage, setStage] = useState("intro"); // intro | lobby | game
  const [room, setRoom] = useState(null); // dokument místnosti
  const [players, setPlayers] = useState([]); // seznam hráčů z Firestore
  const [localQuestions, setLocalQuestions] = useState(null); // lokální sada (fallback nebo import)
  const [loading, setLoading] = useState(false);

  // UI / volby
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [lockRemaining, setLockRemaining] = useState(0);
  const [showCfg, setShowCfg] = useState(false);
  const [fileInfo, setFileInfo] = useState("");
  const [showOnlyUnsolved, setShowOnlyUnsolved] = useState(false);
  const [openInWindow, setOpenInWindow] = useState(true);
  const [jumpTo, setJumpTo] = useState("");
  const [flash, setFlash] = useState(null);

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

  // Sleduj globální zámek a počítej odpočet
  useEffect(() => {
    if (!room?.lockedAt) { setLockRemaining(0); return; }
    const tick = () => {
      const startMs = room.lockedAt?.toMillis ? room.lockedAt.toMillis() : room.lockedAt;
      const rem = Math.max(0, Math.ceil((startMs + PENALTY_MS - Date.now()) / 1000));
      setLockRemaining(rem);
    };
    tick();
    clearInterval(lockTimerRef.current);
    lockTimerRef.current = setInterval(tick, 250);
    return () => clearInterval(lockTimerRef.current);
  }, [room?.lockedAt]);

  // Jakmile kdokoliv ve stejné místnosti spustí hru, automaticky přepni všechny do GAME
  useEffect(() => { if (room?.started && stage !== "game") setStage("game"); }, [room?.started, stage]);

  // Odvozené otázky (definuj PŘED listenerem)
  const effectiveQuestions = useMemo(() => {
    const shared = room?.bank?.items;
    if (Array.isArray(shared) && shared.length) return shared;
    return localQuestions || [];
  }, [room?.bank?.items, localQuestions]);

  // drž vždy aktuální sadu pro handler v popupu
  useEffect(() => { effectiveQuestionsRef.current = effectiveQuestions; }, [effectiveQuestions]);

  const solvedMap = room?.solved || {};
  const solvedCount = Object.keys(solvedMap).length;
  const totalCount = effectiveQuestions.length || 0;
  const allSolved = totalCount > 0 && solvedCount >= totalCount;

  // Pusť fanfáru po dokončení
  useEffect(() => { if (allSolved) playFanfare(); }, [allSolved]);

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
            const now = Date.now();
            const lockedAt = snap.data()?.lockedAt;
            const stillLocked = lockedAt && (lockedAt.toMillis ? (lockedAt.toMillis() + PENALTY_MS > now) : (lockedAt + PENALTY_MS > now));
            if (!stillLocked) tx.update(rRef, { lockedAt: (await getFS(activeConfig)).fs.serverTimestamp(), lockedBy: nick });
          });
        } catch (e) { console.error("Lock TX failed", e); }
        try {
          await fs.addDoc(fs.collection(db, "rooms", normalizeRoom(roomCode), "answers"),
            { qIndex, correct: false, authorId: myId, authorNick: nick, choice: choice, ts: fs.serverTimestamp() });
        } catch (e) { console.error("Log wrong answer failed", e); }
        if (popwin && popwin.postMessage) popwin.postMessage({ type: 'popup-result', qIndex, correct: false }, '*');
      }
    } catch (e) { console.error(e); }
  }

  async function submitAnswerInline(qIndex, choice) {
    return submitAnswerFromPopup(qIndex, choice, null);
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
        await fs.setDoc(roomRef, { createdAt: fs.serverTimestamp(), started: false, lockedAt: null, lockedBy: "", bank: null, solved: {} });
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

      setStage("lobby");
      const presence = setInterval(() => fs.updateDoc(playerRef, { lastSeen: fs.serverTimestamp() }).catch(() => {}), 5000);
      window.addEventListener("beforeunload", () => clearInterval(presence));
    } catch (e) { alert("Chyba připojení: " + e.message); } finally { setLoading(false); }
  }

  // Publikuj sadu otázek do místnosti (vždy override), poté start
  async function startGame() {
    const { fs, db } = await getFS(activeConfig);
    if (!room) return;
    const roomRef = fs.doc(db, "rooms", room.id);
    try {
      const toPublish = Array.isArray(localQuestions) && localQuestions.length ? localQuestions : FALLBACK_QUESTIONS;
      await fs.updateDoc(roomRef, { bank: { items: toPublish }, solved: {} });
      await fs.updateDoc(roomRef, { started: true });
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
            <p className="text-slate-600 text-sm">Týmový režim • kvíz končí po vyřešení všech otázek • špatná odpověď = 10s pauza</p>
          </div>
          {room && (
            <div className="text-right text-sm">
              <div className="font-mono">Místnost: <span className="px-2 py-0.5 rounded bg-slate-200">{room.id}</span></div>
              <div>Vy: <span className="font-semibold">{nick || ""}</span></div>
            </div>
          )}
        </header>

        {stage === "intro" && (
          <div className="bg-white rounded-2xl shadow p-6 grid gap-4">
            <div className="grid gap-2">
              <label className="text-sm text-slate-600">Kód místnosti (A–Z, 0–9):</label>
              <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} className="border rounded-xl px-4 py-3 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Např. DEVOPS" />
            </div>
            <div className="grid gap-2">
              <label className="text-sm text-slate-600">Váš nickname:</label>
              <input value={nick} onChange={(e) => setNick(e.target.value)} className="border rounded-xl px-4 py-3 bg-white text-slate-900 placeholder-slate-400 [color-scheme:light]" placeholder="Např. AnsibleKing" />
            </div>

            {/* Import JSON se sadou otázek */}
            <div className="border rounded-2xl p-4 bg-slate-50">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Import otázek (JSON)</h3>
                <span className="text-xs text-slate-500">{fileInfo}</span>
              </div>
              <div className="mt-3 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                <input type="file" accept="application/json" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  try { const qs = await loadQuestionBankFromFile(f); setLocalQuestions(qs); saveQuestionsToLS(qs); setFileInfo(`Soubor: ${f.name} • ${qs.length} otázek`); }
                  catch (err) { alert(String(err?.message || err)); }
                }} />
                <button className="px-3 py-2 rounded-xl bg-slate-100 border" onClick={() => { clearSavedQuestions(); setFileInfo("Vymazáno"); }}>Vymazat uloženou sadu</button>
              </div>
            </div>

            {/* Nastavení Firebase */}
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

            <div className="flex gap-3 justify-end">
              <button disabled={!configReady || !roomCode || !nick || loading} onClick={joinRoom} className={classNames("px-4 py-3 rounded-2xl text-white", (!configReady || !roomCode || !nick || loading) ? "bg-slate-400" : "bg-slate-900 hover:bg-slate-800")}>{loading ? "Připojuji…" : "Připojit"}</button>
            </div>
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
              <div className="mt-3 text-sm text-slate-600">Sada k publikaci: <strong>{(Array.isArray(localQuestions) && localQuestions.length ? localQuestions.length : FALLBACK_QUESTIONS.length)}</strong> otázek</div>
              <div className="mt-4 flex items-center gap-3">
                <button disabled={!canStart} onClick={startGame} className={classNames("px-4 py-2 rounded-2xl text-white", canStart ? "bg-emerald-600 hover:bg-emerald-500" : "bg-slate-400")}>Start</button>
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
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" className="accent-slate-900" checked={openInWindow} onChange={(e) => setOpenInWindow(e.target.checked)} />
                  Otevírat v novém okně
                </label>
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

              {/* Grid otázek */}
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(2.5rem,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(2.75rem,1fr))]">
                {effectiveQuestions.map((q, i) => {
                  const done = !!solvedMap[i];
                  if (showOnlyUnsolved && done) return null;
                  return (
                    <button key={i} disabled={lockRemaining > 0}
                      className={classNames(
                        "aspect-square w-full rounded-lg border text-sm font-medium flex items-center justify-center quiz-num",
                        done ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-white border-slate-200 hover:bg-slate-50",
                        lockRemaining > 0 && "opacity-60 cursor-not-allowed"
                      )}
                      onClick={() => (openInWindow ? openQuestionPopup(i) : setSelectedIndex(i))}
                      title={q.q}
                    >{i + 1}</button>
                  );
                })}
              </div>

              {/* Inline panel otázek (když není popup) */}
              {!openInWindow && selectedIndex != null && effectiveQuestions[selectedIndex] && (
                <div className="mt-5 border rounded-2xl p-4">
                  <div className="text-sm text-slate-500 mb-1">Otázka #{selectedIndex + 1}</div>
                  <div className="font-medium mb-3">{effectiveQuestions[selectedIndex].q}</div>
                  <div className="grid gap-2">
                    {effectiveQuestions[selectedIndex].options.map((t, idx) => (
                      <button key={idx} disabled={lockRemaining > 0}
                        onClick={() => submitAnswerInline(selectedIndex, idx)}
                        className={classNames("text-left px-3 py-2 rounded-xl border",
                          lockRemaining > 0 ? "bg-slate-100 cursor-not-allowed" : "bg-white hover:bg-slate-50")}
                      >{t}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Stav */}
              <div className="mt-5 text-sm text-slate-600">
                Vyřešeno: <strong>{solvedCount}/{totalCount}</strong>
                {allSolved && (
                  <div className="mission-banner mt-3 w-full text-center text-2xl sm:text-4xl font-extrabold tracking-wide text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">Kód Vaší mise je 2289</div>
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
      </div>
    </div>
  );
}
