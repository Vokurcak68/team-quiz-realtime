import React, { useEffect, useMemo, useRef, useState } from "react";
// =============================================
// Síťový týmový kvíz (2–5 hráčů) – React + Firestore
// =============================================
// Canvas-friendly verze: Firebase se natahuje z CDN, BEZ npm install.
// Vestavěné UI: "Nastavení Firebase" + "Import JSON" se sadou otázek.
// Nový týmový režim: kvíz končí, když jsou VŠECHNY otázky správně
// zodpovězeny libovolným hráčem (globální seznam vyřešených).
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
  // measurementId je volitelný
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
  _fs = fs;
  _db = db;
  _initialized = true;
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

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

function loadSavedConfig() {
  try {
    const raw = localStorage.getItem(LS_FB);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadSavedQuestions() {
  try {
    const raw = localStorage.getItem(LS_QS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveQuestionsToLS(qs) {
  try { localStorage.setItem(LS_QS, JSON.stringify(qs)); } catch {}
}

function clearSavedQuestions() {
  try { localStorage.removeItem(LS_QS); } catch {}
}

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
    // nový volitelný atribut: comment (zpětně kompatibilní s dřívějším explanation)
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
  { q: "Pilsner Urquell pochází z…", options: ["České Budějovice", "Plzeň", "Žatec", "Jihlava"], answer: 1 },
  { q: "Nejdelší česká řeka je…", options: ["Labe", "Morava", "Dyje", "Vltava"], answer: 3 },
  { q: "Který hrad je největší komplex?", options: ["Karlštejn", "Pražský hrad", "Křivoklát", "Hluboká"], answer: 1 },
  { q: "Lázeňství + filmový festival", options: ["Luhačovice", "Karlovy Vary", "Teplice", "Mariánské Lázně"], answer: 1 },
  { q: "Genetika (hrách)", options: ["Purkyně", "Heyrovský", "Mendel", "Wichterle"], answer: 2 },
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

  // Lokální volba otázky + UI
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [lockRemaining, setLockRemaining] = useState(0);
  const [showCfg, setShowCfg] = useState(false);
  const [fileInfo, setFileInfo] = useState("");
const [showOnlyUnsolved, setShowOnlyUnsolved] = useState(false);
const [jumpTo, setJumpTo] = useState("");
const [chatMessages, setChatMessages] = useState([]);
const [chatInput, setChatInput] = useState("");
const chatBoxRef = useRef(null);
const unsubChatRef = useRef(null);
const unsubAnswersRef = useRef(null);
const [answersLog, setAnswersLog] = useState([]);
const [showLog, setShowLog] = useState(false);
const [flash, setFlash] = useState(null);

  // Podmínky pro aktivaci Start
  const canStart = useMemo(() => {
    const count = players.length;
    return configReady && !room?.started && count >= 2 && count <= 5;
  }, [configReady, room?.started, players.length]);

  const unsubRoomRef = useRef(null);
  const unsubPlayersRef = useRef(null);
  const lockTimerRef = useRef(null);

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
    if (!room?.lockedAt) {
      setLockRemaining(0);
      return;
    }
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
  useEffect(() => {
    if (room?.started && stage !== "game") {
      setStage("game");
    }
  }, [room?.started, stage]);

  // Auto-scroll chatu na poslední zprávu
  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [chatMessages.length, stage]);

  function saveFirebaseCfg(next) {
    const merged = { ...firebaseCfg, ...next };
    setFirebaseCfg(merged);
    try { localStorage.setItem(LS_FB, JSON.stringify(merged)); } catch {}
  }

  function resetFirebaseCfg() {
    setFirebaseCfg({ ...firebaseConfigDefaults });
    try { localStorage.removeItem(LS_FB); } catch {}
  }

  // Připojení do místnosti
  async function joinRoom() {
    if (!configReady) {
      alert("Doplňte prosím Firebase konfiguraci v sekci Nastavení.");
      setShowCfg(true);
      return;
    }

    const { fs, db } = await getFS(activeConfig);

    const code = normalizeRoom(roomCode);
    const nickname = nick.trim().slice(0, 24) || "Player";
    setRoomCode(code);
    setNick(nickname);
    localStorage.setItem("tqr:room", code);
    localStorage.setItem("tqr:nick", nickname);

    setLoading(true);
    try {
      const roomRef = fs.doc(db, "rooms", code);
      const snap = await fs.getDoc(roomRef);
      if (!snap.exists()) {
        await fs.setDoc(roomRef, {
          createdAt: fs.serverTimestamp(),
          started: false,
          lockedAt: null,
          lockedBy: "",
          bank: null, // ot. sada bude publikována při Startu
          solved: {}, // mapa vyřešených otázek
        });
      }
      // Zapiš/aktualizuj hráče
      const playerRef = fs.doc(db, "rooms", code, "players", myId);
      await fs.setDoc(
        playerRef,
        {
          nickname,
          score: 0,
          joinedAt: fs.serverTimestamp(),
          lastSeen: fs.serverTimestamp(),
        },
        { merge: true }
      );

      // Subscriptions
      unsubRoomRef.current && unsubRoomRef.current();
      unsubPlayersRef.current && unsubPlayersRef.current();
      unsubRoomRef.current = fs.onSnapshot(roomRef, (d) => setRoom({ id: d.id, ...d.data() }));
      unsubPlayersRef.current = fs.onSnapshot(
        fs.query(fs.collection(db, "rooms", code, "players"), fs.orderBy("joinedAt", "asc")),
        (qs) => {
          const arr = [];
          qs.forEach((x) => arr.push({ id: x.id, ...x.data() }));
          setPlayers(arr);
        }
      );

      // Chat subscription
      unsubChatRef.current && unsubChatRef.current();
      unsubChatRef.current = fs.onSnapshot(
        fs.query(
          fs.collection(db, "rooms", code, "chat"),
          fs.orderBy("ts", "asc"),
          fs.limit(200)
        ),
        (qs) => {
          const arr = [];
          qs.forEach((x) => arr.push({ id: x.id, ...x.data() }));
          setChatMessages(arr);
        }
      );

      // Answers log subscription
      unsubAnswersRef.current && unsubAnswersRef.current();
      unsubAnswersRef.current = fs.onSnapshot(
        fs.query(
          fs.collection(db, "rooms", code, "answers"),
          fs.orderBy("ts", "asc"),
          fs.limit(1000)
        ),
        (qs) => {
          const arr = [];
          qs.forEach((x) => arr.push({ id: x.id, ...x.data() }));
          setAnswersLog(arr);
        }
      );

      setStage("lobby");
      // ping presence
      const presence = setInterval(() => fs.updateDoc(playerRef, { lastSeen: fs.serverTimestamp() }).catch(() => {}), 5000);
      window.addEventListener("beforeunload", () => clearInterval(presence));
    } catch (e) {
      alert("Chyba připojení: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  // Publikuj sadu otázek do místnosti (jednou), poté start
  async function startGame() {
    const { fs, db } = await getFS(activeConfig);
    if (!room) return;

    const roomRef = fs.doc(db, "rooms", room.id);
    try {
      const snap = await fs.getDoc(roomRef);
      const data = snap.data() || {};
      if (!data.bank?.items?.length) {
        const toPublish = Array.isArray(localQuestions) && localQuestions.length ? localQuestions : FALLBACK_QUESTIONS;
        await fs.updateDoc(roomRef, { bank: { items: toPublish }, solved: {} });
      }
      await fs.updateDoc(roomRef, { started: true });
      setStage("game");
    } catch (e) {
      alert("Nelze spustit: " + e.message);
    }
  }

  // Odeslání zprávy v chatu
  async function sendChat() {
    try {
      const text = (chatInput || "").trim();
      if (!text || !room?.id) return;
      const { fs, db } = await getFS(activeConfig);
      await fs.addDoc(
        fs.collection(db, "rooms", room.id, "chat"),
        { text, authorId: myId, authorNick: nick, ts: fs.serverTimestamp() }
      );
      setChatInput("");
    } catch (e) {
      alert("Nelze odeslat: " + e.message);
    }
  }

  // Skok na číslo otázky
  function doJump() {
    const n = parseInt(jumpTo, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= (effectiveQuestions?.length || 0)) {
      const idx = n - 1;
      if (!solvedMap[idx]) setSelectedIndex(idx);
    }
  }

  // Po startu použij sdílenou sadu z roomu; jinak lokální (pre-start náhled)
  const effectiveQuestions = useMemo(() => {
    const shared = room?.bank?.items;
    if (Array.isArray(shared) && shared.length) return shared;
    return localQuestions || [];
  }, [room?.bank?.items, localQuestions]);

  const solvedMap = room?.solved || {};
  const solvedCount = Object.keys(solvedMap).length;
  const totalCount = effectiveQuestions.length || 0;
  const allSolved = totalCount > 0 && solvedCount >= totalCount;

  // Když je vše vyřešeno, můžeme zobrazit banner (inputy necháme vypnuté)

  // === UI ===
  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          {flash && (
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[90%] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl shadow px-4 py-3 text-sm">
              {flash}
            </div>
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
              <input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                className="border rounded-xl px-4 py-3"
                placeholder="Např. DEVOPS"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm text-slate-600">Váš nickname:</label>
              <input
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                className="border rounded-xl px-4 py-3"
                placeholder="Např. AnsibleKing"
              />
            </div>

            {/* Import JSON se sadou otázek */}
            <div className="border rounded-2xl p-4 bg-slate-50">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Import otázek (JSON)</h3>
                <span className="text-xs text-slate-500">{fileInfo}</span>
              </div>
              <div className="mt-3 flex flex-col sm:flex-row gap-3 items-start">
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const qs = await loadQuestionBankFromFile(file);
                      setLocalQuestions(qs);
                      saveQuestionsToLS(qs);
                      setFileInfo(`Načteno z souboru • ${qs.length} otázek`);
                    } catch (err) {
                      alert(err.message || String(err));
                    }
                  }}
                  className="block"
                />
                <button
                  className="px-4 py-2 rounded-xl bg-slate-200"
                  onClick={async () => {
                    clearSavedQuestions();
                    const qs = await loadQuestionBankDefault();
                    setLocalQuestions(qs);
                    setFileInfo(`Výchozí sada • ${qs.length} otázek`);
                  }}
                >
                  Obnovit výchozí sadu
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">Formát: {`{"questions":[{"q":"Text","options":["A","B"],"answer":1,"comment":"Nepovinný komentář po správné odpovědi"}]}`}</p>
            </div>

            {/* Nastavení Firebase */}
            <div className="border rounded-2xl p-4 bg-slate-50">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Nastavení Firebase</h3>
                <button className="text-sm underline" onClick={() => setShowCfg((s) => !s)}>
                  {showCfg ? "Skrýt" : "Otevřít"}
                </button>
              </div>
              {!configReady && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-2">
                  Zadejte Firebase config (nebo použijte soubor <code>firebase.config.json</code> či statický blok v kódu). Uloží se do prohlížeče.
                </p>
              )}
              {(cfgLockedByFile || cfgLockedByStatic) && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mt-2">
                  Konfigurace je načtena {cfgLockedByFile ? 'ze souboru /firebase.config.json' : 'ze statického bloku v kódu'} a UI je pouze informativní.
                </p>
              )}
              {showCfg && (
                <div className="grid sm:grid-cols-2 gap-3 mt-3">$1</div>
              )}
            </div>

            <button
              onClick={joinRoom}
              disabled={loading || !roomCode || !nick || !configReady}
              className={classNames(
                "px-5 py-3 rounded-2xl text-white transition shadow",
                loading || !roomCode || !nick || !configReady ? "bg-slate-400" : "bg-slate-900 hover:opacity-90"
              )}
            >
              Připojit se
            </button>
            <p className="text-xs text-slate-500">
              Pokud nevložíte vlastní JSON, použije se výchozí sada. Při startu hry se aktivní sada **publikuje do místnosti**.
            </p>
          </div>
        )}

        {stage === "lobby" && (
          <div className="bg-white rounded-2xl shadow p-6 grid gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Lobby</h2>
              <div className="text-sm text-slate-600">Hráčů: {players.length} / 5</div>
            </div>
            <ul className="grid sm:grid-cols-2 gap-2">
              {players.map((p) => (
                <li key={p.id} className="border rounded-xl px-3 py-2 flex items-center justify-between">
                  <span>{p.nickname}</span>
                  <span className="text-slate-500 text-sm">{p.score ?? 0} b.</span>
                </li>
              ))}
            </ul>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={startGame}
                  disabled={!canStart}
                  className={classNames(
                    "px-5 py-3 rounded-2xl text-white transition shadow",
                    !canStart ? "bg-slate-400" : "bg-emerald-600 hover:opacity-90"
                  )}
                >
                  Start (publikuje sadu do místnosti)
                </button>
                {!canStart && (
                  <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    {(!configReady)
                      ? "Vyplňte Nastavení Firebase."
                      : room?.started
                        ? "Hra už běží v této místnosti."
                        : players.length < 2
                          ? "Potřebujete alespoň 2 hráče pro start."
                          : players.length > 5
                            ? "Maximálně 5 hráčů v místnosti."
                            : null}
                  </div>
                )}
              </div>

            {/* Chat v lobby */}
            <div className="grid gap-2">
              <h3 className="text-lg font-semibold">Chat</h3>
              <div ref={chatBoxRef} className="h-48 overflow-y-auto border rounded-xl p-3 bg-slate-50">
                {chatMessages.length === 0 ? (
                  <div className="text-sm text-slate-500">Zatím žádné zprávy.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {chatMessages.map((m) => (
                      <li key={m.id} className="text-sm">
                        <span className="font-medium">{m.authorNick || "?"}:</span> <span>{m.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e)=>setChatInput(e.target.value)}
                  onKeyDown={(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); }}}
                  className="flex-1 border rounded-xl px-3 py-2" placeholder="Napište zprávu…"
                />
                <button onClick={sendChat} className="px-4 py-2 rounded-xl bg-slate-900 text-white">Odeslat</button>
              </div>
            </div>

          </div>
        )}

        {(stage === "game") && (
          <div className="grid lg:grid-cols-[2fr_1fr] gap-6">
            {/* Levý panel – otázky */}
            <div className="bg-white rounded-2xl shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Otázky</h2>
                {allSolved ? (
                  <div className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-sm font-medium">
                    Hotovo! Všechny otázky vyřešeny 🎉 Váš kód je 2289
                  </div>
                ) : lockRemaining > 0 ? (
                  <div className="px-3 py-1 rounded-full bg-red-100 text-red-700 text-sm font-medium">
                    Pauza {lockRemaining}s – způsobil: <span className="font-semibold">{room?.lockedBy}</span>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">Vyberte číslo otázky • Vyřešeno {solvedCount}/{totalCount}</div>
                )}
              </div>

              {/* Ovládání výběru */}
              <div className="flex items-center gap-3 text-xs text-slate-600 mb-2">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" className="accent-slate-900" checked={showOnlyUnsolved} onChange={(e)=>setShowOnlyUnsolved(e.target.checked)} />
                  Jen nevyřešené
                </label>
                <div className="flex items-center gap-1">
                  <span>Jít na #</span>
                  <input value={jumpTo} onChange={(e)=>setJumpTo(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter'){ e.preventDefault(); doJump(); }}}
                    className="w-16 border rounded-lg px-2 py-1" placeholder="např. 42" />
                  <button onClick={doJump} className="px-2.5 py-1 rounded-lg border">Jít</button>
                </div>
              </div>

              {/* Grid čísel otázek */}
              <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-1.5">
                {Array.from({ length: effectiveQuestions.length }, (_, i) => i)
                  .filter((i) => !showOnlyUnsolved || !solvedMap[i])
                  .map((i) => {
                  const done = !!solvedMap[i];
                  return (
                    <button
                      key={i}
                      onClick={() => !done && setSelectedIndex(i)}
                      disabled={lockRemaining > 0 || done || allSolved}
                      className={classNames(
                        "w-9 h-9 rounded-lg border text-[11px] font-mono flex items-center justify-center",
                        done ? "bg-emerald-50 border-emerald-300 text-emerald-700" : (lockRemaining > 0 || allSolved) ? "opacity-50 cursor-not-allowed" : "hover:bg-slate-50"
                      )}
                      title={`Otázka ${i + 1}${done ? " (vyřešeno)" : ""}`}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>

              {/* Panel s vybranou otázkou */}
              {selectedIndex != null && effectiveQuestions[selectedIndex] && (
                <div className="mt-6 border-t pt-6">
                  <div className="flex items-start gap-3 mb-3">
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg border font-mono">{selectedIndex + 1}</span>
                    <h3 className="text-lg font-semibold">{effectiveQuestions[selectedIndex].q}</h3>
                  </div>
                  <div className="grid gap-2">
                    {effectiveQuestions[selectedIndex].options.map((opt, oi) => (
                      <button
                        key={oi}
                        onClick={() => {
                          (async () => {
                            if (!configReady || allSolved) return;
                            const { fs, db } = await getFS(activeConfig);
                            const rRef = fs.doc(db, "rooms", normalizeRoom(roomCode));

                            // Pokud už je otázka vyřešena (race), jen zavřít
                            if (solvedMap[selectedIndex]) { setSelectedIndex(null); return; }

                            const q = effectiveQuestions[selectedIndex];
                            const ok = oi === q.answer;
                            if (ok) {
                              try {
                                // 1) přičti skóre hráči
                                await fs.updateDoc(fs.doc(db, "rooms", normalizeRoom(roomCode), "players", myId), { score: fs.increment(1) });
                                // 2) označ otázku za vyřešenou (globálně)
                                const patch = {}; patch[`solved.${selectedIndex}`] = true;
                                await fs.updateDoc(rRef, patch);
                                // 3) log odpovědi (správně) + volitelný komentář ze sady
                                try {
                                  const cm = ((effectiveQuestions[selectedIndex]?.comment) || "").trim();
                                  await fs.addDoc(
                                    fs.collection(db, "rooms", normalizeRoom(roomCode), "answers"),
                                    { qIndex: selectedIndex, correct: true, authorId: myId, authorNick: nick, comment: cm || null, ts: fs.serverTimestamp() }
                                  );
                                  if (cm) {
                                    setFlash(`Hint: ${cm}`);
                                    setTimeout(() => setFlash(null), 6000);
                                  }
                                } catch (e) { console.error("Log correct answer failed", e); }
                              } catch (e) { console.error(e); }
                              setSelectedIndex(null);
                            } else {
                              try {
                                await fs.runTransaction(db, async (tx) => {
                                  const snap = await tx.get(rRef);
                                  const data = snap.data() || {};
                                  const now = Date.now();
                                  const startMs = data.lockedAt?.toMillis ? data.lockedAt.toMillis() : data.lockedAt || 0;
                                  const active = startMs && now < startMs + PENALTY_MS;
                                  if (active) return;
                                  tx.update(rRef, { lockedAt: (await getFS(activeConfig)).fs.serverTimestamp(), lockedBy: nick });
                                });
                              // zapiš do logu pokus (špatně)
                              try {
                                await fs.addDoc(
                                  fs.collection(db, "rooms", normalizeRoom(roomCode), "answers"),
                                  { qIndex: selectedIndex, correct: false, authorId: myId, authorNick: nick, choice: oi, ts: fs.serverTimestamp() }
                                );
                              } catch (err) { console.error("Log wrong answer failed", err); }
                              } catch (e) { console.error("Lock TX failed", e); }
                            }
                          })();
                        }}
                        disabled={lockRemaining > 0 || allSolved}
                        className={classNames(
                          "w-full text-left border rounded-xl px-4 py-3 transition",
                          lockRemaining > 0 || allSolved ? "opacity-50 cursor-not-allowed" : "hover:bg-slate-50"
                        )}
                        title={`Odpověď ${oi + 1}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg border text-sm">{oi + 1}</span>
                          <span>{opt}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Pravý panel – skóre */}
            <aside className="bg-white rounded-2xl shadow p-6">
              <h2 className="text-xl font-semibold mb-3">Skóre</h2>
              <ol className="grid gap-2">
                {players.slice().sort((a,b) => (b.score||0)-(a.score||0)).map((p, idx) => (
                  <li key={p.id} className="border rounded-xl px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-6 text-right text-slate-500">{idx + 1}.</span>
                      <span className={classNames("font-medium", p.id === myId && "text-slate-900")}>{p.nickname}</span>
                    </div>
                    <span className="font-mono">{p.score ?? 0}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-6 text-xs text-slate-500">
                {allSolved ? (
                  <div className="grid gap-2">
                    <span>Kvíz dokončen. Gratulace týmu!</span>
                    <button onClick={() => setShowLog((s)=>!s)} className="w-full px-3 py-2 rounded-xl border">
                      {showLog ? 'Skrýt log odpovědí' : `Zobrazit log odpovědí (${answersLog.length})`}
                    </button>
                    {showLog && (
                      <div className="max-h-64 overflow-y-auto border rounded-xl p-3 bg-slate-50 text-left">
                        {answersLog.length === 0 ? (
                          <div className="text-slate-500">Žádné záznamy.</div>
                        ) : (
                          <ul className="space-y-2">
                            {answersLog.map((e, idx) => (
                              <li key={e.id || idx} className="text-sm">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <span className="font-mono">#{(e.qIndex ?? 0) + 1}</span>
                                    <span className={"ml-2 px-1.5 py-0.5 rounded text-xs " + (e.correct ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>{e.correct ? "správně" : "špatně"}</span>
                                    <span className="ml-2 text-slate-700">{e.authorNick}</span>
                                  </div>
                                  <div className="text-[11px] text-slate-500">{(e.ts?.toDate ? e.ts.toDate() : (e.ts? new Date(e.ts): null))?.toLocaleString?.() || ""}</div>
                                </div>
                                {e.correct && e.comment && (
                                  <div className="mt-1 text-[12px] text-slate-700">Hint: {e.comment}</div>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <span>Špatná odpověď kohokoliv spouští 10s pauzu pro všechny. Vyřešeno {solvedCount}/{totalCount}.</span>
                )}
              </div>

              {/* Chat */}
              <div className="mt-6">
                <h3 className="text-lg font-semibold mb-2">Chat</h3>
                <div ref={chatBoxRef} className="h-56 overflow-y-auto border rounded-xl p-3 bg-slate-50">
                  {chatMessages.length === 0 ? (
                    <div className="text-sm text-slate-500">Zatím žádné zprávy.</div>
                  ) : (
                    <ul className="space-y-1.5">
                      {chatMessages.map((m) => (
                        <li key={m.id} className="text-sm">
                          <span className="font-medium">{m.authorNick || "?"}:</span> <span>{m.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex gap-2 mt-2">
                  <input
                    value={chatInput}
                    onChange={(e)=>setChatInput(e.target.value)}
                    onKeyDown={(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); }}}
                    className="flex-1 border rounded-xl px-3 py-2" placeholder="Napište zprávu…"
                  />
                  <button onClick={sendChat} className="px-4 py-2 rounded-xl bg-slate-900 text-white">Odeslat</button>
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-6 text-center text-xs text-slate-500">
          Tip: Importujte vlastní <code>questions.json</code> výše; nebo vložte soubor ve formátu {`{"questions":[{"q":"Text","options":["A","B"],"answer":1}]}`}.
        </footer>
      </div>
    </div>
  );
}
