// ~/study-chat/server/index.js
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";

import { systemPrompt, buildUserPrompt, pickRandomCast, getCastByHandles, getAllHandles } from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fail fast if OPENAI_API_KEY is missing
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY || !String(OPENAI_API_KEY).trim()) {
  console.error(
    "\n[ERROR] OPENAI_API_KEY is not set. Set it in .env or export OPENAI_API_KEY=sk-...\n" +
      "  Example: echo 'OPENAI_API_KEY=sk-your-key' >> .env\n"
  );
  process.exit(1);
}

const PORT = 3001;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Use normal gpt-4o-mini for all bots (no fine-tuning).
let MODELS = { default: "gpt-4o-mini" };
try {
  const modelsPath = path.join(__dirname, "models.json");
  const raw = fs.readFileSync(modelsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.default) MODELS.default = parsed.default;
} catch (e) {
  console.warn("[WARN] Could not load models.json, using default model:", e?.message);
}

// Optional fixed cast: bot names from CLI args (e.g. node index.js Sid Vivian).
// If non-empty, every new session uses only these bots; otherwise random cast.
const REQUESTED_BOT_NAMES = process.argv.slice(2).map((s) => String(s).trim()).filter(Boolean);
if (REQUESTED_BOT_NAMES.length > 0) {
  const valid = getAllHandles();
  const validLower = new Set(valid.map((h) => h.toLowerCase()));
  const unknown = REQUESTED_BOT_NAMES.filter((n) => !validLower.has(String(n).trim().toLowerCase()));
  if (unknown.length > 0) {
    console.warn("[WARN] Unknown bot name(s), will be skipped:", unknown.join(", "));
    console.warn("[WARN] Valid handles:", valid.join(", "));
  }
  console.log("[CAST] Fixed cast for this run:", REQUESTED_BOT_NAMES.join(", "));
} else {
  console.log("[CAST] No bot names provided; each session will get a random cast of 4 bots.");
  console.log("[CAST] To fix the cast, run: node index.js <name1> [name2 ...]  (e.g. node index.js Sid Vivian Mina)");
}

// All bots use the same default model (no per-bot fine-tuned models).
function getModelForBot() {
  return MODELS.default;
}

// =====================
// Tuning knobs
// =====================
// Per-run log: each instance writes to logs/<YYYY-MM-DD_HH-mm-ss>.txt
const LOG_DIR = path.join(__dirname, "logs");
const runStart = new Date();
const runStamp =
  runStart.getFullYear() +
  "-" +
  String(runStart.getMonth() + 1).padStart(2, "0") +
  "-" +
  String(runStart.getDate()).padStart(2, "0") +
  "_" +
  String(runStart.getHours()).padStart(2, "0") +
  "-" +
  String(runStart.getMinutes()).padStart(2, "0") +
  "-" +
  String(runStart.getSeconds()).padStart(2, "0");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, `${runStamp}.txt`);

// Human idle: consider turn "done" when client sends human_idle.
// Client uses: (empty box + no typing 4s) OR (non-empty box + no typing 10s).
const IDLE_EMPTY_MS = 4000;   // empty text box, no typing for this long → idle
const IDLE_TYPING_MS = 10000; // non-empty text box, no typing for this long → idle

const MAX_ACTIVE_BOTS = 1; // call-on flow: only one bot speaks at a time

// Your rule: anything that hasn't typed for >=10s is fully interruptible.
// - If interrupted in stages 1-3 (GENERATING/THINKING/TYPING<10s before first send): cancel ENTIRE reply and keep them scheduled.
// - If interrupted after first bubble (TYPING/THINKING for later bubbles): keep first bubble, cancel remaining.
const INTERRUPTABLE_TYPED_MS = 10000;

const OPENAI_TIMEOUT_MS = 15000;
const IMPLICIT_WINDOW = 10;

// Moderator bot: name used in transcript and for directive handling.
const MODERATOR_NAME = "Eunice";

// Hardcoded introduction: moderator + what each bot says. No OpenAI during intro.
const INTRO_BUBBLES = [
  "Hi everyone! My name is Eunice, and I'll be moderating today's discussion. Thanks for joining!",
  "Let's go around and introduce ourselves—just your name and anything you'd like to share.",
];

const INTRO_BY_BOT = {
  Jae: "Hi, I'm Jae. I teach high school math in Arlington.",
  Mina: "Hey, I'm Mina. I work retail in LA, Koreatown.",
  Derek: "Hi, I'm Derek. I'm a case worker in Tacoma.",
  Vivian: "Hey everyone, I'm Vivian. I'm a psych undergrad in Atlanta.",
  Anika: "Hi, I'm Anika. I'm a massage therapist in Fremont.",
  Alex: "Hi, I'm Alex. I work at a bank in Bellevue.",
  Dario: "Hey, I'm Dario. I bartend in Austin.",
  Faith: "Hi, I'm Faith. I'm a college student in Irvine.",
  Sid: "Hey, I'm Sid. I do IT support in New Jersey.",
  Alayna: "Hi, I'm Alayna. I work in HR in Raleigh.",
  Lukas: "Hi, I'm Lukas. I'm an engineer in Munich.",
  Camille: "Hi, I'm Camille. I do marketing in Paris.",
  Erik: "Hi, I'm Erik. I work in public-sector IT in Stockholm.",
};

function getIntroForBot(session, botName) {
  const line = INTRO_BY_BOT[botName];
  if (line) return line;
  const p = session.personasByHandle?.[botName];
  const name = p?.full_name || p?.name || botName;
  const city = p?.city ? ` I'm from ${p.city}.` : "";
  return `Hi, I'm ${name}.${city}`.trim();
}

// Intro only: delay between each bot starting to type (ms). Bots can type at once.
const INTRO_STAGGER_MIN_MS = 1000;
const INTRO_STAGGER_MAX_MS = 3000;

// Moderator (Eunice) transcript: sets 1+ (after intro). Set 0 is replaced by INTRO_BUBBLES.
const MODERATOR_TRANSCRIPT = [
  INTRO_BUBBLES,
  [
    "Before we dive in, just a quick note about the goal of this study.\nWe are interested in how people experience new features introduced by large tech companies, and how they decide whether to adopt them or not.",
    "There are no right or wrong answers here. Feel free to talk openly about your own experiences with technology.",
  ],
  [
    "First question: Big tech companies like Google roll out new features pretty often.\n\nHow do you usually feel when a company you use introduces something new?\nDo you tend to try new features right away, or do you usually ignore them at first?",
  ],
  [
    "Moving on, Google recently introduced Gemini as part of its products.\n\nHave any of you used Gemini before?\nWhat made you try it, or what made you decide not to?",
  ],
  [
    "Sometimes when companies introduce new features, they also change how accounts work behind the scenes.\n\nHave you noticed changes to how you access or manage your account over time?\nDo those changes usually feel helpful or annoying?\nDo they ever make you pause before continuing?",
  ],
  [
    "For some Google accounts, users can switch their account login to *passkey*.\n\nHave you seen or heard about passkey before?\nIf you've used it, what made you decide to switch? If you haven't, what held you back?",
  ],
];

// Moderator timing: nudge if no reply 30s after moderator; next set (4+) after 2 min or when discussion done/looping.
const MODERATOR_NUDGE_AFTER_MS = 30_000;
const MODERATOR_NEXT_SET_AFTER_MS = 120_000; // 2 min
const MODERATOR_TIMER_INTERVAL_MS = 15_000;  // check every 15s

// Mention TTL defaults
const MENTION_TTL_MS = 12_000; // 12 seconds
const MENTION_TTL_MSGS = 4; // or 4 messages, whichever comes first

// Human idle detection
const HUMAN_IDLE_MS = 9_000; // human is idle if no typing for 9 seconds
const MAX_DEQUEUE_WHEN_HUMAN_ACTIVE = 3; // max messages to dequeue when human is active
const IDLE_DEQUEUE_COUNT = 3; // number of messages to dequeue when human is idle
const IDLE_DEQUEUE_SPREAD_MS = 10_000; // spread idle dequeues across 10 seconds

// =====================
// Logging
// =====================
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function nowStr() {
  const d = new Date();
  return d.toISOString().replace("T", " ").replace("Z", "");
}
function clip(s, n = 140) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function colorForTag(tag) {
  switch (tag) {
    case "SESSION_START":
    case "SESSION_END":
    case "DISCONNECT":
      return ANSI.magenta;
    case "MESSAGE":
    case "HUMAN_INPUT":
      return ANSI.green;
    case "QUEUE":
      return ANSI.blue;
    case "TYPING":
    case "BOT_STATE":
      return ANSI.cyan;
    case "INTERRUPT":
      return ANSI.yellow;
    case "OPENAI_REQ":
    case "OPENAI_OK":
    case "OPENAI_RTT":
      return ANSI.magenta;
    case "OPENAI_ERR":
    case "ERROR":
      return ANSI.red;
    default:
      return ANSI.gray;
  }
}
function logLine(tag, msg) {
  const ts = nowStr();
  const plain = `${ts} [${tag}] ${msg}`;
  const c = colorForTag(tag);
  console.log(`${ANSI.dim}${ts}${ANSI.reset} ${c}[${tag}]${ANSI.reset} ${msg}`);
  try {
    fs.appendFileSync(LOG_PATH, plain + "\n");
  } catch {}
}

// =====================
// Express + Socket
// =====================
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/profile_pictures", express.static(path.join(__dirname, "..", "profile_pictures")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
});

// =====================
// Conditions
// =====================
const CONDITIONS = ["control", "norm", "authority", "accountability", "skeptic"];
function pickCondition() {
  return CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)];
}

// =====================
// Text utils
// =====================
function buildTranscript(history, maxTurns = 30) {
  return history
    .slice(-maxTurns)
    .map((m) => `${m.name}: ${m.text}`)
    .join("\n");
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureString(x) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "object" && !Array.isArray(x)) {
    const t = x.content ?? x.text ?? x.message ?? x.value;
    if (t != null && typeof t === "string") return t.trim();
    return ""; // don't stringify whole object onto chat
  }
  return String(x).trim();
}

function parseJsonArray(rawText, maxItems = 3) {
  if (!rawText) return [];
  let s = String(rawText).trim();
  // Strip markdown code fences so we don't fail on ```json ... ```
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  function tryParse(str) {
    try {
      const parsed = JSON.parse(str);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((x) => ensureString(x))
        .filter(Boolean)
        .map((x) => x.slice(0, 220))
        .slice(0, maxItems);
    } catch {
      return null;
    }
  }

  let result = tryParse(s);
  if (result) return result;

  // Best-effort repair: extract first [...] from the string
  const arrayMatch = s.match(/\[\s*[\s\S]*?\]/);
  if (arrayMatch) {
    result = tryParse(arrayMatch[0]);
    if (result) return result;
  }

  // Fallback: treat whole cleaned string as single message
  return s ? [s.slice(0, 220)] : [];
}

/**
 * If the message text looks like JSON (array of strings or object with text), decompose it into
 * plain strings so we never print raw JSON in the chat. Returns an array of strings to emit (one or more).
 */
function decomposeJsonMessage(text) {
  if (text == null || typeof text !== "string") return [String(text ?? "").slice(0, 2000)];
  const s = text.trim();
  if (!s || (s[0] !== "[" && s[0] !== "{")) return [s.slice(0, 2000)];

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      const strings = parsed
        .filter((x) => x != null && typeof x === "string")
        .map((x) => String(x).trim())
        .filter(Boolean)
        .map((x) => x.slice(0, 2000));
      if (strings.length > 0) return strings;
    }
    if (parsed && typeof parsed === "object") {
      const content =
        parsed.content ?? parsed.text ?? parsed.message ?? parsed.value ?? parsed.response;
      if (content != null && typeof content === "string") {
        return [content.trim().slice(0, 2000)];
      }
    }
  } catch {
    // Not valid JSON or parse failed — use as-is
  }
  return [s.slice(0, 2000)];
}

function containsHardBanned(text) {
  const t = text || "";
  // Block AI/research/experiment meta mentions; allow "I study psych" / "studying at Emory"
  if (/(as an ai|language model|chatgpt|openai|policy|experiment|irb|deception)/i.test(t))
    return true;
  // Block only when "study" means the research (not "I study X" / "studying Y")
  if (/(this is a study|in this study|our study|the study\b|participat(e|ing) in (a )?study)/i.test(t))
    return true;
  return false;
}

const FILLER_SET = new Set([
  "yeah",
  "yeah true",
  "true",
  "facts",
  "fr",
  "real",
  "same",
  "yeah same",
  "i agree",
  "yeah i agree",
  "agreed",
  "ok",
  "okay",
  "lol",
  "lmao",
  "yep",
  "yup",
  "mhmm",
  "for sure",
]);

function isLowContentBubble(text) {
  const n = normalizeText(text);
  if (!n) return true;
  if (FILLER_SET.has(n)) return true;
  if (n.length <= 4 && !n.includes("?")) return true;
  return false;
}

// Human-ish timing (used by bots)
function humanDelayForText(text) {
  const chars = String(text || "").length;
  const thinking = 250 + Math.random() * 700; // stage 2
  const typingSpeed = 7 + Math.random() * 7; // chars/sec
  const typingTime = (chars / typingSpeed) * 1000; // stage 3
  return { thinking, typingTime };
}

// Moderator: faster typing (and shorter thinking) so Eunice feels snappier
function moderatorDelayForText(text) {
  const chars = String(text || "").length;
  const thinking = 100 + Math.random() * 300; // 100–400 ms
  const typingSpeed = 18 + Math.random() * 12; // 18–30 chars/sec
  const typingTime = (chars / typingSpeed) * 1000;
  return { thinking, typingTime };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================
// Mention detection
// =====================
function detectExplicitMentions(text, botNames) {
  const s = String(text || "");
  const hits = [];
  for (const name of botNames) {
    const n = name.toLowerCase();
    const re = new RegExp(`(^|\\s|@)${n}(\\b|\\s|:|,|\\.|!|\\?)`, "i");
    if (re.test(s)) hits.push(name);
  }
  return hits;
}

async function detectImplicitMention({ history, botNames }) {
  const window = history.slice(-IMPLICIT_WINDOW);
  if (window.length < 2) return [];

  const newest = window[window.length - 1];
  if (detectExplicitMentions(newest.text, botNames).length) return [];

  const names = botNames.join(", ");
  const chat = window.map((m) => `${m.name}: ${m.text}`).join("\n");

  const sys = `
You detect who is being directly addressed in the newest message.

Return targets ONLY when the message clearly addresses someone:
- Addressed to ONE specific person (e.g. question or request to them): return that person only.
- Addressed to EVERYONE/ALL with explicit invite (e.g. "let's introduce ourselves", "what do you all think", "everyone share"): return ALL names except the speaker.

Return EMPTY array when:
- The message is a general statement, opinion, or reaction (e.g. "From my experience...", "I think...", "That makes sense").
- The message is commentary on the topic without asking anyone to respond.
- It is unclear who is being addressed.

When in doubt, return empty array. Only include targets when there is a clear question, request, or explicit group invite.

Output ONLY JSON:
{"targets": [<NAME1>, <NAME2>, ...], "confidence": <0..1>, "reason": "<short>"}

Allowed names must match exactly from the provided list. Exclude the speaker from targets.
`.trim();

  const user = `
Allowed names: ${names}

Chat (most recent last):
${chat}

Newest message:
${newest.name}: "${newest.text}"

Return JSON only. If clearly addressed to everyone/all (explicit invite), include all names except ${newest.name}. If a general statement or opinion with no clear addressee, return empty array.
`.trim();

  logLine("OPENAI_REQ", `implicit_detect newest="${clip(newest.text, 90)}"`);

  try {
    const startMs = Date.now();
    const resp = await openai.responses.create(
      {
        model: MODELS.default,
        input: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      },
      { timeout: OPENAI_TIMEOUT_MS }
    );
    const rttMs = Date.now() - startMs;
    logLine("OPENAI_RTT", `implicit_detect rtt=${rttMs}ms`);

    const raw = (resp.output_text || "").trim();
    logLine("OPENAI_OK", `implicit_detect raw="${clip(raw, 180)}"`);

    const parsed = JSON.parse(raw);
    let targets = parsed?.targets ?? [];
    
    // Handle backward compatibility: if "target" (singular) exists, convert to array
    if (!Array.isArray(targets) && parsed?.target) {
      targets = [parsed.target];
    }
    
    if (!Array.isArray(targets)) targets = [];
    
    const conf = Number(parsed?.confidence ?? 0);

    // Filter: must be valid bot names, not the speaker, and confidence threshold
    const validTargets = targets
      .filter(t => t && botNames.includes(t) && t !== newest.name)
      .filter((t, i, arr) => arr.indexOf(t) === i); // deduplicate

    if (validTargets.length === 0) return [];
    // Require higher confidence so general statements don't create false mention tickets
    if (conf < 0.85) return [];

    return validTargets;
  } catch (e) {
    logLine("OPENAI_ERR", `implicit_detect err="${clip(e?.message, 180)}"`);
    return [];
  }
}

// =====================
// Queue model (WHO speaks next, not message text)
// =====================

function dumpQueues(session, reason = "") {
  const sched = session.scheduleQueue.map((x, i) => {
    if (x.source === "mention") return `${i}:${x.bot}*(m)`;
    if (x.source === "directive") return `${i}:${x.bot}*(d)`;
    return `${i}:${x.bot}`;
  });

  const mentions = session.mentionQueue.map((t, i) => {
    return `${i}:${t.target}`;
  });

  logLine(
    "QUEUE",
    `DUMP ${reason} | schedule=[${sched.join(" ")}] | mentions=[${mentions.join(" ")}]`
  );
}

function scheduleHasBot(session, botName) {
  return session.scheduleQueue.some((x) => x.bot === botName);
}

/** No-op: bots are cued only by moderator (call-on), not by a schedule queue. */
function enqueueSchedule(_session, _item, _opts = {}) {
  // Bots are cued only by moderator; no queue.
}

// Only place that removes a bot's scheduled task when they send. Directive tasks are removed only here (when that bot messages out) or by enqueueModeratorDirective (new directive clears all). Message from another bot must not flush a directed bot's queue.
function dequeueScheduleAfterFirstSend(session, botName) {
  const before = session.scheduleQueue.length;
  session.scheduleQueue = session.scheduleQueue.filter((x) => x.bot !== botName);
  if (session.scheduleQueue.length !== before) {
    logLine("QUEUE", `schedule dequeue bot=${botName} len=${session.scheduleQueue.length}`);
    dumpQueues(session, `after dequeue ${botName}`);
  }
}

function mentionPending(session, botName) {
  return !!session.pendingMentionByBot[botName];
}

function enqueueNormalSpeaker(session) {
  const candidates = session.botNames.filter((b) => !scheduleHasBot(session, b));
  if (!candidates.length) return;

  const bot = candidates[Math.floor(Math.random() * candidates.length)];

  if (mentionPending(session, bot)) {
    const t = session.pendingMentionByBot[bot];
    enqueueSchedule(session, { bot, source: "mention", mentionId: t?.id }, { front: false });
  } else {
    enqueueSchedule(session, { bot, source: "normal" }, { front: false });
  }
}

// =====================
// Mention tickets (so bots answer even if 8+ msgs later)
// =====================
function createMentionTicket(session, targetBot, question, askedBy) {
  const id = `m_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const lastIdx = session.history.length - 1;

  const ticket = {
    id,
    target: targetBot,
    question: String(question || "").trim(),
    askedBy: askedBy || "unknown",
    createdAt: Date.now(),
    createdMsgSeq: session.msgSeq || 0,
    anchorIndex: lastIdx,
    ttlMs: MENTION_TTL_MS,
    ttlMsgs: MENTION_TTL_MSGS,
  };

  if (!session.pendingMentionByBot[targetBot]) {
    session.pendingMentionByBot[targetBot] = ticket;
    session.mentionQueue.push(ticket);
    logLine("QUEUE", `mention + bot=${targetBot} id=${ticket.id} len=${session.mentionQueue.length}`);
    dumpQueues(session, `after create mention ${targetBot}`);
  }

  // Bots are cued only by moderator; no scheduling from mentions.
}

function resolveMention(session, botName, mentionId) {
  const t = session.pendingMentionByBot[botName];
  if (!t) return;
  if (mentionId && t.id !== mentionId) return;

  delete session.pendingMentionByBot[botName];
  session.mentionQueue = session.mentionQueue.filter((x) => x.id !== t.id);

  logLine("QUEUE", `mention - bot=${botName} id=${t.id} len=${session.mentionQueue.length}`);
  dumpQueues(session, `after resolve mention ${botName}`); 
}

// =====================
// Mention TTL (time-to-live) pruning
// =====================
function pruneExpiredMentions(session) {
  const now = Date.now();
  const msgSeq = session.msgSeq || 0;
  
  const before = session.mentionQueue.length;
  session.mentionQueue = session.mentionQueue.filter(m => {
    const ageMs = now - (m.createdAt || 0);
    const ageMsgs = msgSeq - (m.createdMsgSeq || 0);
    const expired = ageMs > (m.ttlMs || MENTION_TTL_MS) || ageMsgs > (m.ttlMsgs || MENTION_TTL_MSGS);
    
    if (expired) {
      // also remove from pendingMentionByBot
      if (session.pendingMentionByBot[m.target]?.id === m.id) {
        delete session.pendingMentionByBot[m.target];
      }
    }
    
    return !expired;
  });

  // ALSO remove expired mention items from schedule queue
  const beforeSched = session.scheduleQueue.length;
  session.scheduleQueue = session.scheduleQueue.filter(task => {
    if (task.source !== "mention") return true;
    // keep only if its mention still exists
    const exists = session.mentionQueue.some(m => m.id === task.mentionId);
    if (!exists && task.mentionId) {
      logLine("QUEUE", `prune expired mention task bot=${task.bot} mentionId=${task.mentionId}`);
    }
    return exists;
  });

  if (session.mentionQueue.length !== before || session.scheduleQueue.length !== beforeSched) {
    logLine("QUEUE", `prune expired mentions: ${before}->${session.mentionQueue.length} mentions, ${beforeSched}->${session.scheduleQueue.length} schedule`);
  }
}


/** Moderator-cue only: who may speak next is the current call-on participant (if a bot). No queue. */
function nextScheduleItem(session) {
  if (!session.callOnOrder?.length || session.currentCallOnIndex >= session.callOnOrder.length) return null;
  const current = session.callOnOrder[session.currentCallOnIndex];
  const humanName = getHumanParticipantName(session);
  if (current === humanName) return null;
  ensureBot(session, current);
  if (session.bots[current].stage !== "IDLE") return null;
  return {
    bot: current,
    source: "directive",
    priorityQ: session.currentQuestionText,
  };
}

// =====================
// Per-bot job state machine (implements your interruption rule)
// Stages:
// 1) GENERATING (OpenAI)
// 2) THINKING (random pause)
// 3) TYPING (typing time)
// 4) SEND (instant)
// 5) repeat THINKING+TYPING+SEND for later bubbles
// =====================
function ensureBot(session, botName) {
  if (!session.bots[botName]) {
    session.bots[botName] = {
      stage: "IDLE", // IDLE|GENERATING|THINKING|TYPING
      timers: [],
      gen: 0, // generation counter
      controller: null, // AbortController for OpenAI
      // plan
      bubbles: [],
      idx: 0,
      sentCount: 0,
      source: "normal",
      mentionId: null,
      // timing
      typingStartedAt: 0,
      // interrupt behavior
      finishCurrentThenStop: false, // set when typing >=10s and interrupted
    };
  }
}

function clearBotTimers(session, botName) {
  ensureBot(session, botName);
  const b = session.bots[botName];
  b.timers.forEach(clearTimeout);
  b.timers = [];
}

function setStage(session, botName, next, meta = "") {
  ensureBot(session, botName);
  const b = session.bots[botName];
  if (b.stage === next) return;
  logLine("BOT_STATE", `bot=${botName} ${b.stage} -> ${next}${meta ? " " + meta : ""}`);
  b.stage = next;
}

// active = not IDLE (counts against MAX_ACTIVE_BOTS)
function activeBotCount(session) {
  let n = 0;
  for (const name of session.botNames) {
    ensureBot(session, name);
    if (session.bots[name].stage !== "IDLE") n++;
  }
  return n;
}

function startTypingIndicator(session, botName) {
  io.to(session.sessionId).emit("typing", { who: botName, isTyping: true });
  logLine("TYPING", `bot=${botName} true`);
}
function stopTypingIndicator(session, botName) {
  io.to(session.sessionId).emit("typing", { who: botName, isTyping: false });
  logLine("TYPING", `bot=${botName} false`);
}

// Core: interruption triggered by ANY NEW MESSAGE (human OR bot).
// Only cancel bots who are TYPING and below threshold. IDLE/GENERATING/THINKING stay as-is (scheduled, not dequeued).
function interruptBotOnNewMessage(session, botName, { by, reason }) {
  ensureBot(session, botName);
  const b = session.bots[botName];
  if (b.stage === "IDLE") return; // just scheduled: stay in queue, don't touch
  if (b.stage === "GENERATING" || b.stage === "THINKING") return; // let them run; don't cancel or dequeue

  // Only act when TYPING: cancel if below threshold, else finish current then stop
  if (b.stage !== "TYPING") return;

  const elapsed = Date.now() - (b.typingStartedAt || 0);

  // Helper: cancel everything and keep them scheduled (restart from stage 1 later). Do NOT dequeue.
  const cancelEntire = (why) => {
    if (b.controller) {
      try {
        b.controller.abort();
      } catch {}
    }
    clearBotTimers(session, botName);
    b.controller = null;
    b.bubbles = [];
    b.idx = 0;
    b.sentCount = 0;
    b.source = "normal";
    b.mentionId = null;
    b.typingStartedAt = 0;
    b.finishCurrentThenStop = false;

    stopTypingIndicator(session, botName);

    logLine("INTERRUPT", `by=${by} bot=${botName} reason=${reason} action=cancel_entire ${why || ""}`.trim());
    dumpQueues(session, `after cancel entire ${botName}`);
    setStage(session, botName, "IDLE");
    // Do NOT dequeue. They stay scheduled and will restart from stage 1.
  };

  // Helper: cancel remaining bubbles (first bubble already sent). Do NOT dequeue (already dequeued after first send).
  const cancelRemaining = (why) => {
    if (b.controller) {
      try {
        b.controller.abort();
      } catch {}
    }
    clearBotTimers(session, botName);
    b.controller = null;
    b.bubbles = [];
    b.idx = 0;
    b.typingStartedAt = 0;
    b.finishCurrentThenStop = false;

    stopTypingIndicator(session, botName);

    logLine("INTERRUPT", `by=${by} bot=${botName} reason=${reason} action=cancel_remaining ${why || ""}`.trim());
    setStage(session, botName, "IDLE");
  };

  if (b.sentCount === 0) {
    // Before first bubble: cancel if typed < threshold, else finish current then stop
    if (elapsed < INTERRUPTABLE_TYPED_MS) {
      cancelEntire(`(typedMs=${elapsed})`);
      return;
    }
    b.finishCurrentThenStop = true;
    logLine("INTERRUPT", `by=${by} bot=${botName} reason=${reason} action=finish_current_then_stop typedMs=${elapsed}`);
    return;
  }

  // After first bubble: same rule for remaining bubbles
  if (elapsed < INTERRUPTABLE_TYPED_MS) {
    cancelRemaining(`(typedMs=${elapsed})`);
    return;
  }
  b.finishCurrentThenStop = true;
  logLine("INTERRUPT", `by=${by} bot=${botName} reason=${reason} action=finish_current_then_stop typedMs=${elapsed}`);
}

function interruptAllBotsOnNewMessage(session, { from, reason }) {
  // When a bot posts a continuation bubble (2nd, 3rd, …), don't interrupt other bots—they never got to speak.
  if (session.botNames.includes(from)) {
    const sender = session.bots[from];
    if (sender && sender.sentCount >= 1) {
      logLine("INTERRUPT", `by=${from} reason=${reason} action=skip_other_bots (continuation bubble sentCount=${sender.sentCount})`);
      return;
    }
  }
  for (const bot of session.botNames) {
    if (bot === from) continue;
    interruptBotOnNewMessage(session, bot, { by: from, reason });
  }
}

// =====================
// Moderator message handling (moderator is Eunice; user is just a participant)
// =====================
function isModeratorMessage(msg) {
  return msg?.name === MODERATOR_NAME || msg?.role === "moderator";
}

// Commentary-only moderator messages do not update directions; only actual directives do.
const COMMENTARY_PHRASES = new Set([
  "ok", "okay", "yeah", "yep", "yup", "nice", "cool", "got it", "i see", "interesting",
  "hmm", "hm", "right", "true", "sure", "mhm", "mhmm", "uh huh", "alright", "k",
  "lol", "haha", "hehe", "thanks", "thank you", "neat", "makes sense", "fair enough",
  "understood", "noted", "same", "same here", "i agree", "agreed", "sounds good",
]);

// Substrings that suggest the message is a directive (question/request), not commentary.
const DIRECTIVE_MARKERS = [
  "?", "please", "tell me", "share", "introduce", "everyone", "you all", "each of you",
  "what do you", "how do you", "can you", "could you", "would you", "let's", "let us",
  "i want you", "i'd like", "answer", "respond", "think about", "give me", "describe",
  "explain", "why do", "why does", "when did", "where ", "who ", "how ", "what ",
];

function isCommentaryOnly(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  const n = normalizeText(s);
  if (COMMENTARY_PHRASES.has(n)) return true;
  // Short message with no directive markers → commentary
  if (s.length <= 30) {
    const lower = s.toLowerCase();
    const hasDirective = DIRECTIVE_MARKERS.some((m) => lower.includes(m));
    if (!hasDirective) return true;
  }
  return false;
}

/** True if moderator message is a nudge (e.g. "What do you think, Alex?"). Nudges do not reset the queue. */
function isModeratorNudge(text) {
  const s = String(text || "").trim();
  return /^What do you think,\s*.+\s*\?$/i.test(s);
}

/**
 * Only the moderator (Eunice) cues who speaks. Return the participant the moderator is explicitly asking to speak
 * (e.g. "Vivian, what do you think?"), not every name in the message. "Thanks, Sid." or "Good point, Sid" = no cue (slipped by).
 */
function getModeratorCuedParticipant(session, text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const bots = session.botNames;
  for (const name of bots) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Name immediately before a cue phrase (e.g. "Vivian, would you agree?" or "Vivian. What do you think?")
    const beforeCueComma = new RegExp(`\\b${escaped}\\s*[,，]\\s*(?:would you|what do you|how do you|do you think|your thoughts|agree|see this)`, "i");
    const beforeCuePeriod = new RegExp(`\\b${escaped}\\s*\\.\\s*(?:What do you|How do you|How about you)`, "i");
    const nameThenQuestion = new RegExp(`\\b${escaped}\\s*\\?`, "i");
    const howAboutYouName = new RegExp(`(?:how about you|what do you think|and you),?\\s*${escaped}\\b`, "i");
    // "Let's start with Sid." / "Start with Sid." / "Begin with Vivian."
    const startWithName = new RegExp(`(?:let'?s?|we'?ll?)?\\s*start\\s+with\\s+${escaped}\\b`, "i");
    const beginWithName = new RegExp(`(?:let'?s?|we'?ll?)?\\s*begin\\s+with\\s+${escaped}\\b`, "i");
    if (beforeCueComma.test(s) || beforeCuePeriod.test(s) || nameThenQuestion.test(s) || howAboutYouName.test(s) || startWithName.test(s) || beginWithName.test(s)) return name;
  }
  return null;
}

/** True if this moderator message is the round-start question (topic question), not a short ack. */
function isRoundStartQuestion(session, text) {
  const s = String(text || "").trim();
  if (s.length < 50) return false;
  return /\b(goal|study|interested|dive in|First question|Moving on|right or wrong)\b/i.test(s) || s.length > 80;
}

/**
 * Going-around flow: randomly decide order, generate Eunice's cue for first person (OpenAI), emit it, then run first person.
 * Who is cued is always read from the ordered list we created, not from parsing Eunice's message.
 */
async function startGoingAroundRound(session, questionText) {
  const humanName = getHumanParticipantName(session);
  const names = [...session.botNames, humanName];
  const order = shuffleArray([...names]);
  session.callOnOrder = order;
  session.currentCallOnIndex = 0;
  session.currentQuestionText = questionText || null;
  session.respondedToCurrentRound = new Set();
  session.disagreementFollowUps = [];
  session.currentCallOnBot = null;
  session.waitingForHumanIdle = false;
  logLine("QUEUE", `call-on started question="${clip(session.currentQuestionText, 60)}" order=[${session.callOnOrder.join(", ")}] (random)`);
  const firstPerson = session.callOnOrder[0];
  const cueLine = await generateEuniceFirstCue(session, firstPerson);
  await emitModeratorMessage(session, cueLine || `Let's start with ${firstPerson}.`);
  startCallOnTurn(session);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Generate Eunice's first cue for the going-around round (e.g. "Let's start with Sid." or "Sid, what do you think?"). */
async function generateEuniceFirstCue(session, firstPersonName) {
  const transcript = buildTranscript(session.history, 15);
  const sys = `You are ${MODERATOR_NAME}, the moderator. Generate a single short line (1 sentence) to cue ${firstPersonName} to speak first. Examples: "Let's start with ${firstPersonName}." or "${firstPersonName}, what do you think?" Keep it natural and brief. Output ONLY that line, no quotes or extra text.`;
  const user = `Discussion so far:\n${transcript}\n\nCue ${firstPersonName} to respond first. Output one short line only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    return (resp.output_text || "").trim().slice(0, 200) || null;
  } catch (e) {
    logLine("OPENAI_ERR", `Eunice first cue: ${e?.message || e}`);
    return null;
  }
}

/**
 * Call-on flow: who speaks is always from the pre-decided order (set in startGoingAroundRound), not from parsing Eunice's message.
 * When we receive a moderator directive with no cue and it's the round-start question, we start the round (random order, generate cue, emit, run first).
 * When we already have an active round and receive a cue message (our own generated cue), we do not overwrite the order.
 */
function enqueueModeratorDirective(session, text) {
  const question = session.lastModeratorDirectiveText; // previous bubble was the question
  session.lastModeratorDirectiveText = text;
  const cued = getModeratorCuedParticipant(session, text);
  if (cued && session.callOnOrder?.length > 0) {
    return;
  }
  if (!cued) {
    if (isRoundStartQuestion(session, text)) {
      setImmediate(() => startGoingAroundRound(session, text).catch((e) => logLine("ERROR", e?.message || e)));
      return;
    }
    logLine("QUEUE", "directive no cue: not starting call-on");
    return;
  }
  const humanName = getHumanParticipantName(session);
  const others = session.botNames.filter((n) => n !== cued);
  session.callOnOrder = [cued, ...others, humanName];
  session.currentCallOnIndex = 0;
  session.currentQuestionText = question || text;
  session.respondedToCurrentRound = new Set();
  session.disagreementFollowUps = [];
  session.currentCallOnBot = null;
  session.waitingForHumanIdle = false;
  logLine("QUEUE", `call-on started question="${clip(session.currentQuestionText, 60)}" order=[${session.callOnOrder.join(", ")}] who_spoke=[]`);
  startCallOnTurn(session);
}

/** Who has spoken in the current round (Stage 1 going-around). */
function getParticipantsWhoSpokeThisRound(session) {
  return new Set(session.respondedToCurrentRound || []);
}

/** Who should speak next in call-on order (first in order who hasn't spoken yet). */
function getNextParticipantToSpeak(session) {
  if (!session.callOnOrder?.length || session.currentCallOnIndex >= session.callOnOrder.length) return null;
  return session.callOnOrder[session.currentCallOnIndex];
}

/**
 * Nudge: in call-on flow we don't use a queue; nudge just logs (or could re-prompt current participant).
 */
function enqueueModeratorNudge(session, text) {
  const cuedBot = getModeratorCuedParticipant(session, text);
  if (cuedBot) logLine("QUEUE", `moderator nudge: ${cuedBot} (call-on flow)`);
}

/**
 * Start the current call-on turn: either run the bot or prompt the human and wait for human_idle.
 * options.alreadyPrompted: true when Eunice already acknowledged and prompted (from onCallOnParticipantDone).
 */
async function startCallOnTurn(session, options = {}) {
  if (!session.callOnOrder?.length || session.currentCallOnIndex >= session.callOnOrder.length) {
    runAfterRoundComplete(session);
    return;
  }
  const current = session.callOnOrder[session.currentCallOnIndex];
  const humanName = getHumanParticipantName(session);
  const isHuman = current === humanName;

  if (isHuman) {
    session.waitingForHumanIdle = true;
    if (options.alreadyPrompted) {
      logLine("QUEUE", `call-on waiting for human ${current} (idle, already prompted)`);
      return;
    }
    const promptText = await generateEuniceCallOnPrompt(session, current);
    if (promptText) {
      await emitModeratorMessage(session, promptText);
    } else {
      await emitModeratorMessage(session, `How about you, ${current}?`);
    }
    logLine("QUEUE", `call-on waiting for human ${current} (idle)`);
    return;
  }

  session.currentCallOnBot = current;
  logLine("QUEUE", `call-on turn: ${current}`);
  await startBotJobIfPossible(session);
}

/** Generate Eunice's "How about you, X?" style prompt via OpenAI to fit context. */
async function generateEuniceCallOnPrompt(session, participantName) {
  const transcript = buildTranscript(session.history, 20);
  const sys = `You are ${MODERATOR_NAME}, the moderator. Generate a single short line (1 sentence) to call on the next participant. Examples: "How about you, Vivian?" or "Vivian, what do you think?" Keep it natural and brief. Output ONLY that line, no quotes or extra text.`;
  const user = `Discussion so far:\n${transcript}\n\nCall on ${participantName} to respond next. Output one short line only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    const line = (resp.output_text || "").trim().slice(0, 200);
    return line || null;
  } catch (e) {
    logLine("OPENAI_ERR", `Eunice call-on prompt: ${e?.message || e}`);
    return null;
  }
}

/**
 * Stage 1: Generate Eunice's message after someone spoke — short (2–3 word) acknowledgment of their response + cue the next participant.
 * Single OpenAI call; output is one short line (e.g. "Good point. Vivian, what do you think?").
 */
async function generateEuniceAckAndCueNext(session, justSpokeName, nextName) {
  const transcript = buildTranscript(session.history, 25);
  const lastFromSpeaker = [...session.history].reverse().find((m) => m.name === justSpokeName);
  const lastResponse = lastFromSpeaker ? lastFromSpeaker.text : "";
  const sys = `You are ${MODERATOR_NAME}, the moderator. Generate ONE short line that: (1) starts with a very brief acknowledgment (2–3 words) of what ${justSpokeName} just said, then (2) cues ${nextName} to speak next (e.g. "${nextName}, what do you think?" or "How about you, ${nextName}?"). Keep the whole line natural and concise. Output ONLY that single line, no quotes or labels.`;
  const user = `Discussion so far:\n${transcript}\n\n${justSpokeName} just said: "${clip(lastResponse, 200)}"\n\nWrite ${MODERATOR_NAME}'s brief acknowledgment (2–3 words) plus cue for ${nextName}. One line only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    const line = (resp.output_text || "").trim().slice(0, 300);
    return line || null;
  } catch (e) {
    logLine("OPENAI_ERR", `Eunice ack+cue: ${e?.message || e}`);
    return null;
  }
}

/** After a participant (bot or human) finishes their call-on turn: track who spoke, Eunice ack+cue next (OpenAI), then advance. */
async function onCallOnParticipantDone(session, participantName) {
  session.respondedToCurrentRound.add(participantName);
  const whoSpoke = Array.from(session.respondedToCurrentRound);
  logLine("QUEUE", `call-on who_spoke=[${whoSpoke.join(", ")}] next_index=${session.currentCallOnIndex + 1}`);
  session.currentCallOnIndex += 1;
  session.currentCallOnBot = null;
  session.waitingForHumanIdle = false;
  if (session.currentCallOnIndex >= session.callOnOrder.length) {
    runAfterRoundComplete(session);
    return;
  }
  const nextName = session.callOnOrder[session.currentCallOnIndex];
  const euniceLine = await generateEuniceAckAndCueNext(session, participantName, nextName);
  if (euniceLine) {
    await emitModeratorMessage(session, euniceLine);
  } else {
    await emitModeratorMessage(session, `Thanks, ${participantName}. ${nextName}, what do you think?`);
  }
  setImmediate(() => startCallOnTurn(session, { alreadyPrompted: true }).catch((e) => logLine("ERROR", e?.message || e)));
}

/** Stage 2: After everyone has responded once (going around done), check disagreements, re-prompt only the disagreed-with person, then next moderator set. */
async function runAfterRoundComplete(session) {
  session.callOnOrder = [];
  session.currentCallOnIndex = 0;
  logLine("QUEUE", "round complete: who_spoke=" + Array.from(session.respondedToCurrentRound || []).join(", ") + "; checking disagreements");
  const disagreements = await detectDisagreements(session);
  if (disagreements.length > 0) {
    session.inDisagreementFollowUp = true;
    for (const { disagreedWith, by } of disagreements) {
      const promptText = await generateEuniceDisagreementPrompt(session, disagreedWith, by);
      if (promptText) await emitModeratorMessage(session, promptText);
      else await emitModeratorMessage(session, `${by} disagreed with you. What do you think about their viewpoint?`);
      session.callOnOrder = [disagreedWith];
      session.currentCallOnIndex = 0;
      session.currentQuestionText = promptText || `${by} disagreed with you. What do you think?`;
      session.currentCallOnBot = disagreedWith;
      await startBotJobIfPossible(session);
      while (session.bots[disagreedWith]?.stage !== "IDLE") {
        await delay(300);
      }
      session.currentCallOnBot = null;
    }
    session.inDisagreementFollowUp = false;
  }
  const humanName = getHumanParticipantName(session);
  const humanDisagreed = disagreements.filter((d) => d.disagreedWith === humanName);
  if (humanDisagreed.length > 0) {
    const by = humanDisagreed[0].by;
    const promptText = await generateEuniceDisagreementPrompt(session, humanName, by);
    if (promptText) await emitModeratorMessage(session, promptText);
    else await emitModeratorMessage(session, `${by} had a different view. What do you think about that?`);
    session.waitingForHumanDisagreementResponse = true;
    return;
  }
  setImmediate(() => trySendNextModeratorSet(session));
}

/** Generate Eunice's prompt when someone was disagreed with (e.g. "Vivian disagreed with you. What do you think?"). */
async function generateEuniceDisagreementPrompt(session, disagreedWith, by) {
  const transcript = buildTranscript(session.history, 25);
  const sys = `You are ${MODERATOR_NAME}, the moderator. Someone (${by}) disagreed with ${disagreedWith}. Generate one short sentence asking ${disagreedWith} to respond to ${by}'s viewpoint. Natural and brief. Output ONLY that sentence.`;
  const user = `Discussion:\n${transcript}\n\nGenerate one short line for ${MODERATOR_NAME} to ask ${disagreedWith} to respond.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    return (resp.output_text || "").trim().slice(0, 200) || null;
  } catch (e) {
    logLine("OPENAI_ERR", `Eunice disagreement prompt: ${e?.message || e}`);
    return null;
  }
}

/**
 * When a participant (bot or human) mentions/cues another participant, moderator intervenes:
 * paraphrases the speaker's point and cues the mentioned person by name (so the cue comes from Eunice, not the participant).
 */
async function triggerModeratorParaphraseAndCueIfParticipantCuedSomeone(session, lastMessage) {
  if (!lastMessage || lastMessage.name === MODERATOR_NAME) return;
  if (session.waitingForHumanIntro || session.inHardcodedIntro) return;
  const speaker = lastMessage.name;
  const text = lastMessage.text || "";
  const explicit = detectExplicitMentions(text, session.botNames).filter((t) => t !== speaker);
  const implicit = await detectImplicitMention({ history: session.history, botNames: session.botNames });
  const targets = [...new Set([...explicit, ...implicit])].filter((t) => t && t !== speaker);
  if (targets.length === 0) return;
  const cuedName = targets[0];
  const paraphraseLine = await generateModeratorParaphraseAndCue(session, lastMessage, cuedName);
  if (paraphraseLine) await emitModeratorMessage(session, paraphraseLine);
}

async function generateModeratorParaphraseAndCue(session, lastMessage, cuedName) {
  const transcript = buildTranscript(session.history, 20);
  const sys = `You are ${MODERATOR_NAME}, the moderator. A participant just addressed or cued ${cuedName}. Write ONE short line that: (1) briefly paraphrases or acknowledges what the speaker said, then (2) explicitly cues ${cuedName} to respond (e.g. "${cuedName}, what do you think?" or "How about you, ${cuedName}?"). The cue must come from the moderator, not the participant. Output ONLY that line, no quotes or labels.`;
  const user = `Discussion:\n${transcript}\n\n${lastMessage.name} said: "${clip(lastMessage.text, 300)}"\n\nWrite ${MODERATOR_NAME}'s brief paraphrase and cue for ${cuedName}. One line only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    return (resp.output_text || "").trim().slice(0, 400) || null;
  } catch (e) {
    logLine("OPENAI_ERR", `moderator paraphrase+cue: ${e?.message || e}`);
    return null;
  }
}

/** Check if moderator (Eunice) should intervene after a message (e.g. clarify terms, answer confusion). Do NOT intervene for intros or follow-up chitchat. */
async function checkModeratorIntervention(session, lastMessage) {
  if (!lastMessage || lastMessage.name === MODERATOR_NAME) return;
  if (session.waitingForHumanIntro || session.inHardcodedIntro) return;
  const transcript = buildTranscript(session.history, 25);
  const sys = `You are ${MODERATOR_NAME}, the moderator. Decide if you should intervene after the latest message. Intervene ONLY when: (1) someone is confused about a term or the question and needs a definition, (2) someone explicitly asks for clarification of the task or a term, (3) the discussion needs a brief factual clarification only. Do NOT intervene for: introductions, "great to meet you", follow-up questions (e.g. "what are you studying?"), social chitchat, normal agreement/disagreement, or general chat. Reply with exactly "YES" or "NO" only.`;
  const user = `Discussion:\n${transcript}\n\nShould ${MODERATOR_NAME} intervene to give a clarification or answer a confusion after the latest message? YES or NO only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    const raw = (resp.output_text || "").trim().toUpperCase();
    if (!raw.startsWith("YES")) return;
    const reply = await getModeratorInterventionResponse(session, lastMessage);
    if (reply) await emitModeratorMessage(session, reply);
  } catch (e) {
    logLine("OPENAI_ERR", `moderator intervention check: ${e?.message || e}`);
  }
}

/** Generate Eunice's clarification/response when she intervenes. Only factual clarifications or direct answers to confusion—no follow-up questions or chitchat. */
async function getModeratorInterventionResponse(session, lastMessage) {
  const transcript = buildTranscript(session.history, 25);
  const sys = `You are ${MODERATOR_NAME}, the moderator. Write a SHORT clarification or direct answer (1-3 sentences) to address the person's confusion or question only. Do NOT ask follow-up questions (e.g. "What are you studying?"), do NOT say "great to meet you" or social chitchat. Only clarify a term, answer a factual question, or briefly explain the task. Output ONLY the moderator's reply, no quotes or labels.`;
  const user = `Discussion:\n${transcript}\n\nLatest message: ${lastMessage.name}: "${lastMessage.text}"\n\nWrite ${MODERATOR_NAME}'s brief clarification or answer to their confusion/question only. No follow-up questions or social reply.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    return (resp.output_text || "").trim().slice(0, 500) || null;
  } catch (e) {
    logLine("OPENAI_ERR", `moderator intervention response: ${e?.message || e}`);
    return null;
  }
}

/**
 * Stage 2: Detect disagreements (disagreedWith = person to re-prompt; we prompt them, not the one who disagreed).
 * Include: (1) A disagreed with B → re-ask B. (2) A bot expressed opposing view to the human's view → re-ask the human.
 * Only real disagreements/opposing views, not agreements or neutral comments.
 */
async function detectDisagreements(session) {
  const lastMajorIdx = session.lastMajorModeratorMessageHistoryIndex ?? getLastModeratorMessageIndex(session);
  if (lastMajorIdx < 0) return [];
  const window = session.history.slice(lastMajorIdx + 1);
  if (window.length < 2) return [];
  const chat = window.map((m) => `${m.name}: ${m.text}`).join("\n");
  const participants = getParticipantNames(session).join(", ");
  const humanName = getHumanParticipantName(session);
  const sys = `You detect DISAGREEMENTS or opposing views in the discussion. For each case where someone should be re-asked to respond:
1) A clearly disagreed with B (B's view was challenged by A) → we re-ask B: {"disagreedWith": "B", "by": "A"}.
2) A bot expressed an opposing or disagreeing view toward the human's view (even if the human spoke last) → we re-ask the human: {"disagreedWith": "${humanName}", "by": "BotName"}.
Only include real disagreements or opposing viewpoints, not agreements or neutral comments. Output a JSON array of objects: [{"disagreedWith": "NameOfPersonToReAsk", "by": "NameOfPersonWhoDisagreedOrOpposed"}]. If no disagreements, output []. Output ONLY the JSON array.`;
  const user = `Participants: ${participants}. Human participant: ${humanName}.\n\nDiscussion:\n${chat}\n\nList each disagreement: who should be re-asked (disagreedWith) and who disagreed/opposed (by). JSON only.`;
  try {
    const resp = await openai.responses.create({
      model: MODELS.default,
      input: [{ role: "system", content: sys }, { role: "user", content: user }],
    }, { timeout: OPENAI_TIMEOUT_MS });
    const raw = (resp.output_text || "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && x.disagreedWith && x.by).slice(0, 10);
  } catch (e) {
    logLine("OPENAI_ERR", `detect disagreements: ${e?.message || e}`);
    return [];
  }
}

// =====================
// Moderator (Eunice) flow: transcript, timing, nudge, and “done/looping” check
// =====================
function getHumanParticipantName(session) {
  return session.participantName || "You";
}

function getParticipantNames(session) {
  return [...session.botNames, getHumanParticipantName(session)];
}

function getLastModeratorMessageIndex(session) {
  for (let i = session.history.length - 1; i >= 0; i--) {
    if (session.history[i].name === MODERATOR_NAME) return i;
  }
  return -1;
}

function getParticipantsWhoRepliedSinceLastModerator(session) {
  const lastModIdx = session.lastModeratorMessageHistoryIndex ?? getLastModeratorMessageIndex(session);
  if (lastModIdx < 0) return new Set();
  const replied = new Set();
  for (let i = lastModIdx + 1; i < session.history.length; i++) {
    const name = session.history[i].name;
    if (name && name !== MODERATOR_NAME) replied.add(name);
  }
  return replied;
}

/** Round = since moderator's last major (non-nudge) text. Used for nudge so we nudge human when they didn't reply but all others did. */
function getParticipantsWhoRepliedSinceLastMajorModerator(session) {
  const lastMajorIdx =
    session.lastMajorModeratorMessageHistoryIndex ??
    session.lastModeratorMessageHistoryIndex ??
    getLastModeratorMessageIndex(session);
  if (lastMajorIdx < 0) return new Set();
  const replied = new Set();
  for (let i = lastMajorIdx + 1; i < session.history.length; i++) {
    const name = session.history[i].name;
    if (name && name !== MODERATOR_NAME) replied.add(name);
  }
  return replied;
}

function countParticipantMessagesSinceLastModerator(session) {
  const lastModIdx = session.lastModeratorMessageHistoryIndex ?? getLastModeratorMessageIndex(session);
  if (lastModIdx < 0) return session.history.filter((m) => m.name !== MODERATOR_NAME).length;
  let n = 0;
  for (let i = lastModIdx + 1; i < session.history.length; i++) {
    if (session.history[i].name !== MODERATOR_NAME) n++;
  }
  return n;
}

/** Count participant (non-moderator) messages since last *major* moderator message (excludes nudges). Used for 2-bubble rule after "Before we dive in...". */
function countParticipantMessagesSinceLastMajorModerator(session) {
  const lastMajorIdx =
    session.lastMajorModeratorMessageHistoryIndex ??
    session.lastModeratorMessageHistoryIndex ??
    getLastModeratorMessageIndex(session);
  if (lastMajorIdx < 0) return session.history.filter((m) => m.name !== MODERATOR_NAME).length;
  let n = 0;
  for (let i = lastMajorIdx + 1; i < session.history.length; i++) {
    if (session.history[i].name !== MODERATOR_NAME) n++;
  }
  return n;
}

function allIntroductionsDone(session) {
  const setIndex = session.moderatorSetIndex ?? 0;
  if (setIndex < 1) return false;
  const participants = new Set(getParticipantNames(session));
  const replied = getParticipantsWhoRepliedSinceLastModerator(session);
  for (const p of participants) {
    if (!replied.has(p)) return false;
  }
  return true;
}

/** For sets 1+, return only the question; going-around order and first cue are decided in startGoingAroundRound (random order, OpenAI-generated cue). */
function getModeratorSetBubbles(session, setIndex) {
  if (setIndex >= 1 && setIndex < MODERATOR_TRANSCRIPT.length) {
    const question = Array.isArray(MODERATOR_TRANSCRIPT[setIndex])
      ? MODERATOR_TRANSCRIPT[setIndex][0]
      : MODERATOR_TRANSCRIPT[setIndex];
    return question;
  }
  return MODERATOR_TRANSCRIPT[setIndex];
}

/**
 * Next moderator set when triggered by participant messages (sets 1–3).
 */
function getNextModeratorBubble(session) {
  const setIndex = session.moderatorSetIndex ?? 0;
  if (setIndex >= MODERATOR_TRANSCRIPT.length) return null;

  if (setIndex === 0) return MODERATOR_TRANSCRIPT[0];

  if (setIndex === 1) {
    if (allIntroductionsDone(session)) return getModeratorSetBubbles(session, 1);
    return null;
  }

  if (setIndex === 2) {
    const lastMajorIdx =
      session.lastMajorModeratorMessageHistoryIndex ??
      session.lastModeratorMessageHistoryIndex ??
      getLastModeratorMessageIndex(session);
    const lastMajorText = lastMajorIdx >= 0 && session.history[lastMajorIdx] ? (session.history[lastMajorIdx].text || "") : "";
    const lastMajorIsSet2 =
      lastMajorText.includes("Before we dive in") || lastMajorText.includes("There are no right or wrong");
    if (!lastMajorIsSet2) return null;
    const countSinceMajor = countParticipantMessagesSinceLastMajorModerator(session);
    logLine("QUEUE", `moderator set 3 check: ${countSinceMajor} participant bubbles since last major (need 2)`);
    if (countSinceMajor >= 2) return getModeratorSetBubbles(session, 2);
    return null;
  }

  return null;
}

/**
 * Called from timer: send set 4 or 5 after 2 min since last moderator, or when discussion seems done/looping.
 */
async function checkDiscussionDoneOrLooping(session) {
  const lastModIdx = session.lastModeratorMessageHistoryIndex ?? getLastModeratorMessageIndex(session);
  if (lastModIdx < 0) return false;
  const participants = getParticipantNames(session);
  const window = session.history.slice(lastModIdx + 1, lastModIdx + 1 + 20);
  // Need enough messages that there was actual discussion on the moderator's topic (not just 1–2 replies)
  if (window.length < Math.max(3, participants.length + 2)) return false;
  const chat = window.map((m) => `${m.name}: ${m.text}`).join("\n");
  const sys =
    "You judge whether the moderator's last question or topic has had real discussion and then reached a natural pause or repetition. " +
    "Only answer YES if (1) multiple participants have replied to the moderator's last topic, and (2) the discussion has reached a natural pause or is repeating the same points. " +
    "If there has been little or no discussion on the moderator's last topic, answer NO. Answer only YES or NO.";
  const user = `Chat since moderator's last message:\n${chat}\n\nHas there been real discussion on the moderator's last topic and has it reached a natural pause or repetition? Answer only YES or NO.`;
  try {
    const startMs = Date.now();
    const resp = await openai.responses.create(
      {
        model: MODELS.default,
        input: [{ role: "system", content: sys }, { role: "user", content: user }],
      },
      { timeout: OPENAI_TIMEOUT_MS }
    );
    const rttMs = Date.now() - startMs;
    logLine("OPENAI_RTT", `moderator done/loop check rtt=${rttMs}ms`);
    const raw = (resp.output_text || "").trim().toUpperCase();
    return raw.startsWith("YES");
  } catch (e) {
    logLine("OPENAI_ERR", `moderator done/loop check err=${clip(e?.message, 120)}`);
    return false;
  }
}

/**
 * Next moderator set when triggered by timer (sets 4–5): 2 min since last mod or discussion done/looping,
 * and only after all participants have replied to the current moderator message.
 */
async function getNextModeratorBubbleFromTimer(session) {
  const setIndex = session.moderatorSetIndex ?? 0;
  if (setIndex < 3 || setIndex >= MODERATOR_TRANSCRIPT.length) return null;

  // For 3rd set and later: moderator waits for everyone to respond before moving on
  if (!allIntroductionsDone(session)) return null;

  // Require substantive discussion on this question: at least (everyone replied) + 2 extra messages since current moderator message
  const participants = getParticipantNames(session);
  const minMessagesForDiscussion = participants.length + 2;
  const countSinceLastMod = countParticipantMessagesSinceLastModerator(session);
  if (countSinceLastMod < minMessagesForDiscussion) return null;

  const lastAt = session.lastModeratorMessageAt ?? 0;
  const elapsed = Date.now() - lastAt;
  if (elapsed < MODERATOR_NEXT_SET_AFTER_MS) {
    const done = await checkDiscussionDoneOrLooping(session);
    if (!done) return null;
  }

  return getModeratorSetBubbles(session, setIndex);
}

/**
 * Send one or more messages as the moderator (Eunice). Uses moderatorDelayForText (faster than bots).
 * Updates moderator state when setIndex is provided.
 * Set moderatorSetIndex immediately so a mid-send trySendNextModeratorSet (from setImmediate) does not re-send the same set.
 * options.instant: if true, no thinking/typing delay (message pops up immediately).
 */
async function emitModeratorMessage(session, text, setIndex = null, options = {}) {
  if (setIndex != null) {
    session.moderatorSetIndex = setIndex;
    session.moderatorNudgeSentAfterLastMessage = false;
  }

  const instant = !!options.instant;
  const bubbles = Array.isArray(text) ? text : [text];
  for (const t of bubbles) {
    const msg = { name: MODERATOR_NAME, text: String(t || "").trim(), ts: Date.now() };
    if (!msg.text) continue;

    const { thinking, typingTime } = instant ? { thinking: 0, typingTime: 0 } : moderatorDelayForText(msg.text);
    await delay(thinking);
    io.to(session.sessionId).emit("typing", { who: MODERATOR_NAME, isTyping: true });
    logLine("TYPING", `moderator true`);
    await delay(typingTime);
    io.to(session.sessionId).emit("typing", { who: MODERATOR_NAME, isTyping: false });
    logLine("TYPING", `moderator false`);

    emitAndRecordMessage(session, msg);
  }
  // Always update last moderator time so nudge timing is from last message (avoids double nudge)
  session.lastModeratorMessageAt = Date.now();
  if (setIndex != null) {
    session.lastModeratorMessageHistoryIndex = session.history.length - 1;
  }
}

/**
 * Send Eunice's intro: first bubble at 1s (instant), second bubble with normal thinking/typing.
 * No bots send in between. Bot loops start only after the second bubble is sent.
 */
function sendFirstModeratorSetAfterLoad(session) {
  if ((session.moderatorSetIndex ?? 0) !== 0) return;
  const intro = INTRO_BUBBLES;
  if (!intro || intro.length < 2) return;
  emitModeratorMessage(session, intro[0], null, { instant: true })
    .then(() => emitModeratorMessage(session, intro[1], 1, { instant: false }))
    .then(() => runHardcodedIntro(session));
}

/** One bot's intro: thinking → typing → send. Used in parallel with staggered start. */
async function runOneBotIntro(session, botName) {
  const text = getIntroForBot(session, botName);
  const { thinking, typingTime } = humanDelayForText(text);
  await delay(thinking);
  io.to(session.sessionId).emit("typing", { who: botName, isTyping: true });
  logLine("TYPING", `bot=${botName} true`);
  await delay(typingTime);
  io.to(session.sessionId).emit("typing", { who: botName, isTyping: false });
  logLine("TYPING", `bot=${botName} false`);
  emitAndRecordMessage(session, { name: botName, text, ts: Date.now() });
}

/** Play hardcoded intro: bots start typing with 1–3s stagger (can type at once), then moderator asks the human. */
async function runHardcodedIntro(session) {
  logLine("QUEUE", "hardcoded intro: bots stagger 1–3s, then human");
  session.inHardcodedIntro = true;
  const staggerMs = () =>
    INTRO_STAGGER_MIN_MS + Math.random() * (INTRO_STAGGER_MAX_MS - INTRO_STAGGER_MIN_MS);
  let delayMs = 0;
  const promises = session.botNames.map((botName) => {
    const startAfter = delayMs;
    delayMs += staggerMs();
    return new Promise((resolve) => {
      setTimeout(() => runOneBotIntro(session, botName).then(resolve), startAfter);
    });
  });
  await Promise.all(promises);
  const humanName = getHumanParticipantName(session);
  session.inHardcodedIntro = false;
  await emitModeratorMessage(session, `How about you, ${humanName}?`);
  session.waitingForHumanIntro = true;
  logLine("QUEUE", `waiting for human intro from ${humanName}`);
}

/**
 * Try to send the next moderator set when triggered by a participant message (sets 1–3).
 */
async function trySendNextModeratorSet(session) {
  const next = getNextModeratorBubble(session);
  if (next == null) return;
  const setIndex = (session.moderatorSetIndex ?? 0) + 1;
  await emitModeratorMessage(session, next, setIndex);
  logLine("QUEUE", `moderator set ${setIndex} sent (after participant message)`);
}

/**
 * Try to send the next moderator set from the timer (sets 4–5), or nudge if 30s and someone hasn’t replied.
 */
async function runModeratorTimerTick(session) {
  const lastAt = session.lastModeratorMessageAt ?? 0;
  const setIndex = session.moderatorSetIndex ?? 0;

  // Nudge: 30s since last moderator message and at least one participant hasn’t replied. Skip only for set 2 (“Before we dive in…”), where we only need 2 bubbles (setIndex 2 = we’ve sent that set).
  if (lastAt > 0 && setIndex !== 2 && !session.moderatorNudgeSentAfterLastMessage) {
    const elapsed = Date.now() - lastAt;
    if (elapsed >= MODERATOR_NUDGE_AFTER_MS) {
      const participants = getParticipantNames(session); // bots + human with display name from first page
      const replied = getParticipantsWhoRepliedSinceLastMajorModerator(session);
      const notReplied = participants.filter((p) => !replied.has(p));
      logLine("NUDGE", `not replied: ${JSON.stringify(notReplied)}`);
      if (notReplied.length > 0) {
        const humanName = getHumanParticipantName(session);
        const humanNotReplied = notReplied.includes(humanName);
        // Prefer nudging the human when they haven't replied (e.g. first moderator text); otherwise first non-replier
        const name = humanNotReplied ? humanName : notReplied[0];
        await emitModeratorMessage(session, `What do you think, ${name}?`);
        session.moderatorNudgeSentAfterLastMessage = true;
        logLine("QUEUE", `moderator nudge sent to ${name}`);
      }
    }
  }

  // Sets 4–5: 2 min since last mod or discussion done/looping
  if (setIndex >= 3 && setIndex < MODERATOR_TRANSCRIPT.length) {
    const next = await getNextModeratorBubbleFromTimer(session);
    if (next != null) {
      const nextSetIndex = setIndex + 1;
      await emitModeratorMessage(session, next, nextSetIndex);
      logLine("QUEUE", `moderator set ${nextSetIndex} sent (timer: 2min or done/looping)`);
    }
  }
}

// =====================
// Mention detectors runner
// =====================
/**
 * Participant mentions/cues are not used for queue. Only the moderator (Eunice) cues who speaks.
 * When a participant cues someone, triggerModeratorParaphraseAndCueIfParticipantCuedSomeone (from emitAndRecordMessage) handles it:
 * moderator intervenes with paraphrase + cue. We do not create mention tickets from participant messages.
 */
async function runMentionDetectors(session, newestMsg) {
  if (!newestMsg || newestMsg.name === MODERATOR_NAME) return;
  // Do not create mention tickets when a participant cues another—moderator will intervene with paraphrase + cue instead.
}

// =====================
// OpenAI generation (stage 1)
// =====================
async function generateBubbles({ session, botName, source = "normal", priorityQuestion = null }) {
  const transcript = buildTranscript(session.history, 30);
  const others = session.botNames.filter((n) => n !== botName).join(", ");
  const persona = session.personasByHandle[botName] || {};

  const humanName = getHumanParticipantName(session);
  const sys = systemPrompt(botName, others, session.condition, persona, MODERATOR_NAME, humanName);

  const respondTo =
    source === "directive" && priorityQuestion
      ? { type: "directive", text: priorityQuestion }
      : source === "mention" && priorityQuestion
      ? { type: "mention", text: priorityQuestion }
      : null;

  const userPrompt = buildUserPrompt({
    transcript,
    recentBot: "",
    recentQs: "",
    mode: "human",
    botName,
    otherName: others,
    respondTo,
    moderatorName: MODERATOR_NAME,
    humanParticipantName: humanName,
  });

  logLine(
    "OPENAI_REQ",
    `bot=${botName} mode=human condition=${session.condition} priorityQ="${clip(priorityQuestion || "", 90)}"`
  );
  logLine(
    "OPENAI_REQ",
    `bot=${botName} ctx="${clip(transcript.split("\n").slice(-6).join(" | "), 240)}"`
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, OPENAI_TIMEOUT_MS);

  const model = getModelForBot(botName);
  logLine("OPENAI_REQ", `bot=${botName} model=${model}`);

  try {
    const startMs = Date.now();
    const resp = await openai.responses.create({
      model,
      input: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      // OpenAI JS supports fetch under the hood; AbortController works here.
      // signal: controller.signal,
    });
    const rttMs = Date.now() - startMs;
    logLine("OPENAI_RTT", `bot=${botName} rtt=${rttMs}ms`);

    // logLine("OPENAI_REQ_SYSTEM", sys);
    // logLine("OPENAI_REQ_USER", userPrompt);

    const raw = (resp.output_text || "").trim();
    logLine("OPENAI_OK", `bot=${botName} raw="${clip(raw, 220)}"`);

    let bubbles = parseJsonArray(raw, 3);
    bubbles = bubbles.filter((b) => !containsHardBanned(b));
    bubbles = bubbles.filter((b) => !isLowContentBubble(b));
    if (!bubbles.length) bubbles = ["wait what", "say more"];

    return { bubbles: bubbles.slice(0, 3), controller: null };
  } catch (e) {
    logLine("OPENAI_ERR", `bot=${botName} err="${clip(e?.message, 220)}"`);
    return { bubbles: ["uh wait", "my bad", "what was that again"], controller: null };
  } finally {
    clearTimeout(timeout);
  }
}

// =====================
// Speaking pipeline (implements your rule exactly)
// =====================
// When a bot is interrupted (by human or another bot): they are reset to IDLE and stay scheduled.
// On their next run, startBotJobIfPossible → generateBubbles uses session.history *at that moment*,
// so the new OpenAI request sees the current transcript including the message that interrupted.
// We trigger an immediate dequeue after interrupt so they restart quickly with current context.

async function tryDequeueNow(session) {
  // If moderator has cued someone (call-on), run that bot once. No queue.
  while (activeBotCount(session) < MAX_ACTIVE_BOTS) {
    const before = activeBotCount(session);
    await startBotJobIfPossible(session);
    if (activeBotCount(session) === before) break;
  }
}

function emitAndRecordMessage(session, msg) {
  const rawText = typeof msg.text === "string" ? msg.text : ensureString(msg.text) || String(msg.text ?? "").slice(0, 500);
  const name = msg.name;
  const ts = msg.ts ?? Date.now();

  // If the message looks like JSON (e.g. raw ["bubble1","bubble2"]), decompose into plain strings so we never print JSON in the chat
  const texts = decomposeJsonMessage(rawText);
  let firstNormalized = null;
  const historyStart = session.history.length;

  for (const text of texts) {
    const normalized = { name, text: text.slice(0, 2000), ts };
    if (!firstNormalized) firstNormalized = normalized;
    session.msgSeq = (session.msgSeq || 0) + 1;
    session.history.push(normalized);
    io.to(session.sessionId).emit("message", normalized);
    logLine("MESSAGE", `[${normalized.name}] "${clip(normalized.text, 160)}"`);
  }

  if (!firstNormalized) return;

  // No one may respond between Eunice's first bubble ("Hi everyone!...") and second ("To start us off...").
  // When moderatorSetIndex is still 0, we've only sent the first bubble; skip enqueue/dequeue until the second is sent.
  const isIntroFirstBubbleOnly = isModeratorMessage(firstNormalized) && (session.moderatorSetIndex ?? 0) === 0;

  interruptAllBotsOnNewMessage(session, { from: name, reason: "new_message" });
  if (!isIntroFirstBubbleOnly && !session.inHardcodedIntro) {
    setImmediate(() => tryDequeueNow(session).catch(() => {}));
  }

  // Moderator directive updates directions; use first message for logic (commentary/nudge/directive)
  if (isModeratorMessage(firstNormalized)) {
    if (isIntroFirstBubbleOnly) {
      logLine("QUEUE", "moderator intro first bubble only: not enqueueing bots or next moderator set");
      // Do not enqueue directive or trySendNextModeratorSet; second bubble will be sent by sendFirstModeratorSetAfterLoad
    } else if (isCommentaryOnly(firstNormalized.text)) {
      logLine("QUEUE", `moderator commentary only: not updating directions`);
    } else if (isModeratorNudge(firstNormalized.text)) {
      enqueueModeratorNudge(session, firstNormalized.text);
    } else {
      session.lastMajorModeratorMessageHistoryIndex = historyStart; // first message of this batch
      enqueueModeratorDirective(session, firstNormalized.text);
    }
  } else {
    if (session.inHardcodedIntro) {
      // Skip mention/directive/next-set during hardcoded intro
    } else {
      const inCallOn = session.callOnOrder?.length > 0 && session.currentCallOnIndex < session.callOnOrder.length;
      const fromCurrentCallOnBot = inCallOn && session.currentCallOnBot === name;
      if (!fromCurrentCallOnBot) {
        setImmediate(() => trySendNextModeratorSet(session));
      }
      // When a participant cues another, moderator intervenes with paraphrase + cue (so the cue comes from Eunice, not the participant).
      setImmediate(() => triggerModeratorParaphraseAndCueIfParticipantCuedSomeone(session, firstNormalized).catch((e) => logLine("OPENAI_ERR", e?.message || e)));
      // For all participant messages (bot and human): check if moderator should intervene (e.g. clarify terms, answer confusion).
      setImmediate(() => checkModeratorIntervention(session, firstNormalized).catch((e) => logLine("OPENAI_ERR", e?.message || e)));
    }
  }
}

async function startBotJobIfPossible(session) {
  if (activeBotCount(session) >= MAX_ACTIVE_BOTS) return;

  const item = nextScheduleItem(session);
  if (!item) return;

  const botName = item.bot;
  ensureBot(session, botName);
  const b = session.bots[botName];

  if (b.stage !== "IDLE") return;

  // Setup plan meta
  b.gen += 1;
  const myGen = b.gen;

  // Only moderator-cued: item is always from call-on (directive).
  b.source = "directive";
  b.mentionId = null;
  b.bubbles = [];
  b.idx = 0;
  b.sentCount = 0;
  b.finishCurrentThenStop = false;

  const priorityQuestion = item.priorityQ || null;

  // Stage 1: GENERATING (OpenAI)
  setStage(session, botName, "GENERATING", `source=${b.source}`);
  // NOTE: in your rule, if any other message arrives during stage 1, we cancelEntire and will restart later.

  const { bubbles } = await generateBubbles({
    session,
    botName,
    source: b.source,
    priorityQuestion,
  });

  // If canceled during generate, bot would be IDLE and/or gen mismatch.
  if (b.stage !== "GENERATING" || b.gen !== myGen) return;

  b.bubbles = bubbles;
  b.idx = 0;

  // Stage 2: THINKING (random pause) before first bubble
  setStage(session, botName, "THINKING");
  const { thinking } = humanDelayForText(b.bubbles[b.idx]);

  clearBotTimers(session, botName);
  const tThink = setTimeout(() => {
    if (b.gen !== myGen) return;
    if (b.stage !== "THINKING") return;

    // Stage 3: TYPING
    setStage(session, botName, "TYPING", `bubble=${b.idx + 1}/${b.bubbles.length}`);
    b.typingStartedAt = Date.now();
    startTypingIndicator(session, botName);

    const { typingTime } = humanDelayForText(b.bubbles[b.idx]);
    clearBotTimers(session, botName);

    const tType = setTimeout(() => {
      if (b.gen !== myGen) return;
      if (b.stage !== "TYPING") return;

      const bubble = b.bubbles[b.idx];
      const msg = { name: botName, text: bubble, ts: Date.now() };

      // Stage 4: SEND
      stopTypingIndicator(session, botName);
      b.typingStartedAt = 0;

      emitAndRecordMessage(session, msg);

      if (b.sentCount === 0) {
        // call-on: no queue to dequeue
      }
      b.sentCount += 1;

      // If interrupted after >=10s typing, we finish this bubble and stop here.
      if (b.finishCurrentThenStop) {
        b.finishCurrentThenStop = false;
        b.bubbles = [];
        b.idx = 0;
        b.sentCount = 0;
        b.source = "normal";
        b.mentionId = null;
        setStage(session, botName, "IDLE");
        return;
      }

      // Next bubble?
      b.idx += 1;
      if (b.idx >= b.bubbles.length) {
        b.bubbles = [];
        b.idx = 0;
        b.sentCount = 0;
        b.source = "normal";
        b.mentionId = null;
        setStage(session, botName, "IDLE");
        if (!session.inDisagreementFollowUp && session.currentCallOnBot === botName) {
          session.currentCallOnBot = null;
          setImmediate(() => onCallOnParticipantDone(session, botName).catch((e) => logLine("ERROR", e?.message || e)));
        }
        return;
      }

      // Stage 5: repeat THINKING -> TYPING -> SEND for remaining bubbles
      setStage(session, botName, "THINKING", `nextBubble=${b.idx + 1}/${b.bubbles.length}`);
      const { thinking: thinking2 } = humanDelayForText(b.bubbles[b.idx]);
      clearBotTimers(session, botName);

      const tThink2 = setTimeout(() => {
        if (b.gen !== myGen) return;
        if (b.stage !== "THINKING") return;

        setStage(session, botName, "TYPING", `bubble=${b.idx + 1}/${b.bubbles.length}`);
        b.typingStartedAt = Date.now();
        startTypingIndicator(session, botName);

        const { typingTime: typing2 } = humanDelayForText(b.bubbles[b.idx]);
        clearBotTimers(session, botName);

        const tType2 = setTimeout(() => {
          if (b.gen !== myGen) return;
          if (b.stage !== "TYPING") return;

          const bubble2 = b.bubbles[b.idx];
          stopTypingIndicator(session, botName);
          b.typingStartedAt = 0;

          emitAndRecordMessage(session, { name: botName, text: bubble2, ts: Date.now() });
          b.sentCount += 1;

          if (b.finishCurrentThenStop) {
            b.finishCurrentThenStop = false;
            b.bubbles = [];
            b.idx = 0;
            b.sentCount = 0;
            b.source = "normal";
            b.mentionId = null;
            setStage(session, botName, "IDLE");
            return;
          }

          b.idx += 1;
          if (b.idx >= b.bubbles.length) {
            b.bubbles = [];
            b.idx = 0;
            b.sentCount = 0;
            b.source = "normal";
            b.mentionId = null;
            setStage(session, botName, "IDLE");
            if (!session.inDisagreementFollowUp && session.currentCallOnBot === botName) {
              session.currentCallOnBot = null;
              setImmediate(() => onCallOnParticipantDone(session, botName).catch((e) => logLine("ERROR", e?.message || e)));
            }
            return;
          }

          // chain by calling startBotJobIfPossible() tick will keep going anyway
          // but we continue within this job with another THINK->TYPE loop:
          setStage(session, botName, "THINKING", `nextBubble=${b.idx + 1}/${b.bubbles.length}`);
          const { thinking: thinking3 } = humanDelayForText(b.bubbles[b.idx]);
          clearBotTimers(session, botName);

          const tThink3 = setTimeout(() => {
            if (b.gen !== myGen) return;
            if (b.stage !== "THINKING") return;

            setStage(session, botName, "TYPING", `bubble=${b.idx + 1}/${b.bubbles.length}`);
            b.typingStartedAt = Date.now();
            startTypingIndicator(session, botName);

            const { typingTime: typing3 } = humanDelayForText(b.bubbles[b.idx]);
            clearBotTimers(session, botName);

            const tType3 = setTimeout(() => {
              if (b.gen !== myGen) return;
              if (b.stage !== "TYPING") return;

              const bubble3 = b.bubbles[b.idx];
              stopTypingIndicator(session, botName);
              b.typingStartedAt = 0;

              emitAndRecordMessage(session, { name: botName, text: bubble3, ts: Date.now() });
              b.sentCount += 1;

              // stop if requested
              if (b.finishCurrentThenStop) {
                b.finishCurrentThenStop = false;
                b.bubbles = [];
                b.idx = 0;
                b.sentCount = 0;
                b.source = "normal";
                b.mentionId = null;
                setStage(session, botName, "IDLE");
                return;
              }

              b.bubbles = [];
              b.idx = 0;
              b.sentCount = 0;
              b.source = "normal";
              b.mentionId = null;
              setStage(session, botName, "IDLE");
              if (!session.inDisagreementFollowUp && session.currentCallOnBot === botName) {
                session.currentCallOnBot = null;
                setImmediate(() => onCallOnParticipantDone(session, botName).catch((e) => logLine("ERROR", e?.message || e)));
              }
            }, typing3);

            b.timers.push(tType3);
          }, thinking3);

          b.timers.push(tThink3);
        }, typing2);

        b.timers.push(tType2);
      }, thinking2);

      b.timers.push(tThink2);
    }, typingTime);

    b.timers.push(tType);
  }, thinking);

  b.timers.push(tThink);
}

// =====================
// Tickers (no queue: bots cued only by moderator)
// =====================
function startNormalEnqueueLoop(_session) {
  // No-op: no schedule queue; bots are cued only by moderator.
}

function isHumanIdle(session) {
  const now = Date.now();
  const timeSinceLastTyping = now - (session.humanLastTypingAt || 0);
  return timeSinceLastTyping > HUMAN_IDLE_MS;
}

function resetDequeueCounter(session) {
  session.dequeuedCountSinceHumanActive = 0;
}

function startDequeueLoop(_session) {
  // No-op: no queue; moderator cues set callOnOrder and startCallOnTurn runs the bot once.
}

function stopLoops(session) {
  if (session.normalEnqueueTimer) clearInterval(session.normalEnqueueTimer);
  session.normalEnqueueTimer = null;
  if (session.dequeueTimer) clearTimeout(session.dequeueTimer);
  session.dequeueTimer = null;
  if (session.moderatorTimer) clearInterval(session.moderatorTimer);
  session.moderatorTimer = null;
}

// =====================
// Socket handling
// =====================
io.on("connection", (socket) => {
  const sessionId = socket.id;
  const condition = pickCondition();

  const cast =
    REQUESTED_BOT_NAMES.length > 0
      ? getCastByHandles(REQUESTED_BOT_NAMES)
      : pickRandomCast(4);
  const botNames = cast.map((p) => p.handle);
  if (cast.length < 2) {
    logLine("SESSION_START", `WARN: only ${cast.length} bot(s) in cast; seed may repeat.`);
  }

  const personasByHandle = {};
  for (const p of cast) personasByHandle[p.handle] = p;

  const session = {
    sessionId,
    condition,
    startedAt: Date.now(),
    history: [],
    msgSeq: 0,

    botNames,
    personasByHandle,

    // call-on flow (no queue): one participant at a time
    callOnOrder: [],
    currentCallOnIndex: 0,
    currentQuestionText: null,
    respondedToCurrentRound: new Set(),
    waitingForHumanIdle: false,
    disagreementFollowUps: [],
    currentCallOnBot: null,
    inDisagreementFollowUp: false,
    waitingForHumanDisagreementResponse: false,
    waitingForHumanIntro: false,
    inHardcodedIntro: false,

    // No schedule queue: bots cued only by moderator (callOnOrder).
    scheduleQueue: [],
    mentionQueue: [],
    pendingMentionByBot: {},

    // per-bot jobs
    bots: {},

    // moderator (Eunice) flow
    moderatorSetIndex: 0,
    lastModeratorMessageAt: 0,
    lastModeratorMessageHistoryIndex: -1,
    lastMajorModeratorMessageHistoryIndex: -1,
    lastModeratorDirectiveText: null,
    moderatorNudgeSentAfterLastMessage: false,
    moderatorTimer: null,

    // human participant display name
    participantName: null,
  };

  for (const b of botNames) ensureBot(session, b);

  logLine("SESSION_START", `id=${sessionId} condition=${condition} bots=${botNames.join(",")}`);

  socket.emit("session", {
    sessionId,
    condition,
    bots: botNames,
    moderatorName: MODERATOR_NAME,
    idleEmptyMs: IDLE_EMPTY_MS,
    idleTypingMs: IDLE_TYPING_MS,
  });

  // Eunice's first bubble at 1s (instant); second bubble with thinking/typing; then start bots (no bot messages in between).
  setTimeout(() => sendFirstModeratorSetAfterLoad(session), 1000);

  // Bot enqueue/dequeue start only after Eunice's second bubble (inside sendFirstModeratorSetAfterLoad).

  // Moderator timer: nudge after 30s if someone hasn’t replied; send sets 4–5 after 2 min or when discussion done/looping.
  session.moderatorTimer = setInterval(() => {
    runModeratorTimerTick(session).catch((e) => logLine("OPENAI_ERR", `moderator tick: ${e?.message || e}`));
  }, MODERATOR_TIMER_INTERVAL_MS);

  socket.on("participant_name", ({ name }) => {
    const n = name != null && typeof name === "string" ? String(name).trim() : "";
    session.participantName = n || "You";
    logLine("SESSION_START", `participant_name set to "${session.participantName}"`);
  });

  socket.on("human_typing", ({ isTyping }) => {
    logLine("TYPING", `human ${isTyping ? "true" : "false"}`);
    
    if (isTyping) {
      session.humanLastTypingAt = Date.now();
      resetDequeueCounter(session);
      logLine("QUEUE", `human typing: reset dequeue counter`);
    }
  });

  socket.on("human_message", async ({ text }) => {
    const t = String(text || "").trim();
    if (!t) return;

    const humanName = getHumanParticipantName(session);
    logLine("HUMAN_INPUT", `[${humanName}] "${clip(t, 160)}"`);

    session.humanLastTypingAt = Date.now();
    if (session.waitingForHumanIntro) {
      session.waitingForHumanIntro = false;
      setImmediate(() => trySendNextModeratorSet(session));
    } else if (session.waitingForHumanDisagreementResponse) {
      session.waitingForHumanDisagreementResponse = false;
      setImmediate(() => trySendNextModeratorSet(session));
    }

    interruptAllBotsOnNewMessage(session, { from: humanName, reason: "new_human_message" });

    const msg = { name: humanName, text: t, ts: Date.now() };
    emitAndRecordMessage(session, msg);
  });

  socket.on("human_idle", () => {
    if (!session.waitingForHumanIdle) return;
    const humanName = getHumanParticipantName(session);
    logLine("QUEUE", `human_idle from ${humanName}`);
    session.waitingForHumanIdle = false;
    onCallOnParticipantDone(session, humanName).catch((e) => logLine("ERROR", e?.message || e));
  });

  socket.on("disconnect", () => {
    // interrupt all jobs
    for (const b of session.botNames) {
      interruptBotOnNewMessage(session, b, { by: "SYSTEM", reason: "disconnect" });
    }
    stopLoops(session);
    logLine("DISCONNECT", `id=${sessionId}`);
  });

  socket.on("end", () => {
    for (const b of session.botNames) {
      interruptBotOnNewMessage(session, b, { by: "SYSTEM", reason: "end" });
    }
    stopLoops(session);
    logLine("SESSION_END", `id=${sessionId}`);
  });
});

// =====================
// Optional endpoint
// =====================
app.post("/api/login_choice", (req, res) => {
  const { sessionId, choice, hesitationMs } = req.body || {};
  logLine(
    "SESSION_END",
    `id=${sessionId} [LOGIN_CHOICE] choice=${choice} hesitationMs=${hesitationMs ?? ""}`
  );
  res.json({ ok: true });
});

server.listen(PORT, () => {
  logLine("SESSION_START", `backend running on http://localhost:${PORT}`);
});
