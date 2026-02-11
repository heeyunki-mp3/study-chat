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

// Load per-bot model config (default + fine-tuned model IDs)
let MODELS = { default: "gpt-4.1-mini", bots: {} };
try {
  const modelsPath = path.join(__dirname, "models.json");
  const raw = fs.readFileSync(modelsPath, "utf8");
  MODELS = JSON.parse(raw);
  if (!MODELS.bots) MODELS.bots = {};
} catch (e) {
  console.warn("[WARN] Could not load models.json, using default model only:", e?.message);
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

function getModelForBot(botName) {
  const id = MODELS.bots[botName];
  // Placeholder IDs (e.g. ft:...:ORG:MINA_MODEL_ID) mean "not trained yet" → use default
  if (!id || String(id).includes("_MODEL_ID")) return MODELS.default;
  return id;
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

const NORMAL_ENQUEUE_MS = 3000;
const DEQUEUE_MIN_MS = 1000;
const DEQUEUE_MAX_MS = 2000;

const MAX_ACTIVE_BOTS = 3; // bots that can be in GENERATING/THINKING/TYPING at once

// Your rule: anything that hasn't typed for >=10s is fully interruptible.
// - If interrupted in stages 1-3 (GENERATING/THINKING/TYPING<10s before first send): cancel ENTIRE reply and keep them scheduled.
// - If interrupted after first bubble (TYPING/THINKING for later bubbles): keep first bubble, cancel remaining.
const INTERRUPTABLE_TYPED_MS = 10000;

const OPENAI_TIMEOUT_MS = 15000;
const IMPLICIT_WINDOW = 10;

// Moderator bot: name used in transcript and for directive handling.
const MODERATOR_NAME = "Eunice";

// Moderator (Eunice) transcript: 6 sets of bubbles, sent in order based on timing rules.
const MODERATOR_TRANSCRIPT = [
  [
    "Hi everyone! My name is Eunice, and I'll be moderating today's discussion. Thanks for joining!",
    "To start us off, can we go around and do quick introductions? You can just share your name and anything you feel like mentioning.",
  ],
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

function enqueueSchedule(session, item, { front = false } = {}) {
  // item: { bot, source: "mention"|"normal"|"directive", mentionId?: string, createdAt?: number, priorityQ?: string }
  if (!item?.bot) return;

  // Directive tasks are only removed when (1) that bot sends a message (dequeueScheduleAfterFirstSend) or (2) new moderator directive. Message from another bot must not replace or flush a directed bot's task.
  const existing = session.scheduleQueue.find((x) => x.bot === item.bot);
  if (existing?.source === "directive" && item.source !== "directive") return;

  // Prune expired mentions before enqueueing
  pruneExpiredMentions(session);

  // prevent duplicates (unless it's a directive, which can override)
  if (scheduleHasBot(session, item.bot) && item.source !== "directive") return;

  // if enqueue mention or directive, remove any existing entry for same bot
  session.scheduleQueue = session.scheduleQueue.filter((x) => x.bot !== item.bot);

  // Set createdAt if not provided
  if (!item.createdAt) item.createdAt = Date.now();

  if (front) session.scheduleQueue.unshift(item);
  else session.scheduleQueue.push(item);

  logLine("QUEUE", `schedule +${item.source} bot=${item.bot} len=${session.scheduleQueue.length}`);
  dumpQueues(session, `after enqueue ${item.bot}`);
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

  // ensure scheduled (mentions have priority)
  enqueueSchedule(session, { bot: targetBot, source: "mention", mentionId: ticket.id }, { front: true });
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


// Priority constants
const PRIORITY = { directive: 3, mention: 2, normal: 1 };

function nextScheduleItem(session) {
  // Prune expired mentions first
  pruneExpiredMentions(session);

  // ensure mention targets are in schedule (front)
  if (session.mentionQueue.length) {
    for (const t of session.mentionQueue) {
      if (!scheduleHasBot(session, t.target)) {
        enqueueSchedule(session, { bot: t.target, source: "mention", mentionId: t.id }, { front: true });
      }
    }
  }

  // Sort: directive > mention > normal; then moderator-mentioned first; then createdAt (older first)
  const sorted = [...session.scheduleQueue].sort((a, b) => {
    const pa = PRIORITY[a.source] ?? 0;
    const pb = PRIORITY[b.source] ?? 0;
    if (pb !== pa) return pb - pa;
    const am = a.moderatorMentioned ? 1 : 0;
    const bm = b.moderatorMentioned ? 1 : 0;
    if (bm !== am) return bm - am;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  // Return first item whose bot is IDLE so we don't block on one busy bot (e.g. directive for Mina
  // while Mina is GENERATING — we can start Vivian, Anika, Erik instead)
  for (const item of sorted) {
    ensureBot(session, item.bot);
    if (session.bots[item.bot].stage === "IDLE") return item;
  }
  return null;
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
 * If the moderator text mentions a specific participant by name (@Name or "…, Name" / "Name, …"), return that name.
 * Only returns names that are bots (human responds manually). Returns null if none or not a bot.
 */
function getModeratorMentionedParticipant(session, text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const participants = getParticipantNames(session);
  for (const name of participants) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const atMention = new RegExp(`@${escaped}\\b`, "i");
    const commaMention = new RegExp(`[,，]\\s*${escaped}\\b|\\b${escaped}\\s*[,，]`, "i");
    const wordMention = new RegExp(`\\b${escaped}\\b`, "i");
    if (atMention.test(s) || commaMention.test(s) || wordMention.test(s)) {
      if (session.botNames.includes(name)) return name;
      break;
    }
  }
  return null;
}

/**
 * Non-nudge moderator message: reset direction queue, clear all mentions, requeue only this message's directive for all bots.
 */
function enqueueModeratorDirective(session, text) {
  pruneExpiredMentions(session);
  session.mentionQueue = [];
  session.pendingMentionByBot = {};

  const before = session.scheduleQueue.length;
  session.scheduleQueue = [];
  if (before > 0) {
    logLine("QUEUE", `cleared all ${before} scheduled tasks for new moderator directive`);
  }

  const now = Date.now();
  const mentionedBot = getModeratorMentionedParticipant(session, text);

  const directiveTasks = session.botNames.map((bot) => ({
    kind: "directive",
    bot,
    source: "directive",
    priorityQ: text,
    createdAt: now,
    createdMsgSeq: session.msgSeq || 0,
    moderatorMentioned: bot === mentionedBot,
  }));

  if (mentionedBot) {
    const idx = directiveTasks.findIndex((t) => t.bot === mentionedBot);
    if (idx > 0) {
      const [task] = directiveTasks.splice(idx, 1);
      directiveTasks.unshift(task);
    }
    logLine("QUEUE", `moderator mentioned ${mentionedBot} → front of queue`);
  } else {
    // Rotate who goes first each moderator set so the same bot doesn't always respond first.
    const setIndex = session.moderatorSetIndex ?? 0;
    const offset = setIndex % session.botNames.length;
    if (offset > 0) {
      const rotated = [...directiveTasks.slice(offset), ...directiveTasks.slice(0, offset)];
      directiveTasks.length = 0;
      directiveTasks.push(...rotated);
      logLine("QUEUE", `directive order rotated by ${offset} (set ${setIndex}) first=${directiveTasks[0]?.bot}`);
    }
  }

  session.scheduleQueue = directiveTasks;
  session.lastModeratorDirectiveText = text;
  logLine("QUEUE", `directive + all bots (${session.botNames.length}) len=${session.scheduleQueue.length}`);
  dumpQueues(session, `after moderator directive`);
}

/**
 * Nudge: only move the nudged bot to the front of the queue. Keep their existing direction (priorityQ); do not set the nudge as the new direction.
 */
function enqueueModeratorNudge(session, text) {
  const mentionedBot = getModeratorMentionedParticipant(session, text);
  if (!mentionedBot) return;

  const existingIdx = session.scheduleQueue.findIndex((t) => t.bot === mentionedBot);
  if (existingIdx < 0) {
    // Not in queue: add at front with the last moderator directive (not the nudge text)
    const priorityQ = session.lastModeratorDirectiveText || text;
    const now = Date.now();
    session.scheduleQueue.unshift({
      kind: "directive",
      bot: mentionedBot,
      source: "directive",
      priorityQ,
      createdAt: now,
      createdMsgSeq: session.msgSeq || 0,
      moderatorMentioned: true,
    });
    logLine("QUEUE", `moderator nudge: ${mentionedBot} added at front (direction=last directive)`);
  } else {
    // Already in queue: move existing task to front without changing its direction
    const [existingTask] = session.scheduleQueue.splice(existingIdx, 1);
    session.scheduleQueue.unshift(existingTask);
    logLine("QUEUE", `moderator nudge: ${mentionedBot} moved to front (direction unchanged)`);
  }
  dumpQueues(session, `after moderator nudge`);
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

/**
 * Next moderator set when triggered by participant messages (sets 1–3).
 */
function getNextModeratorBubble(session) {
  const setIndex = session.moderatorSetIndex ?? 0;
  if (setIndex >= MODERATOR_TRANSCRIPT.length) return null;

  // Set 1 (Eunice intro): send immediately so "Hi everyone! My name is Eunice..." is the first thing participants see
  if (setIndex === 0) return MODERATOR_TRANSCRIPT[0];

  // Set 2 ("Before we dive in..." / "There are no right or wrong..."): after all have replied since set 1
  if (setIndex === 1) {
    if (allIntroductionsDone(session)) return MODERATOR_TRANSCRIPT[1];
    return null;
  }

  // Set 3 ("First question..."): after "Before we dive in...", only need 2 participant bubbles (since last major mod; don't wait for everyone).
  // Only apply when last major moderator message is actually from set 2 (we set moderatorSetIndex=2 at start of emit, so a mid-send setImmediate can run before set 2 bubbles are in history).
  if (setIndex === 2) {
    const lastMajorIdx =
      session.lastMajorModeratorMessageHistoryIndex ??
      session.lastModeratorMessageHistoryIndex ??
      getLastModeratorMessageIndex(session);
    const lastMajorText = lastMajorIdx >= 0 && session.history[lastMajorIdx] ? (session.history[lastMajorIdx].text || "") : "";
    const lastMajorIsSet2 =
      lastMajorText.includes("Before we dive in") || lastMajorText.includes("There are no right or wrong");
    if (!lastMajorIsSet2) return null; // still sending set 2 or not sent yet
    const countSinceMajor = countParticipantMessagesSinceLastMajorModerator(session);
    logLine("QUEUE", `moderator set 3 check: ${countSinceMajor} participant bubbles since last major (need 2)`);
    if (countSinceMajor >= 2) return MODERATOR_TRANSCRIPT[2];
    return null;
  }

  // Sets 4 and 5 are sent from the timer; they wait for everyone and nudge if needed (allIntroductionsDone in timer path)
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

  return MODERATOR_TRANSCRIPT[setIndex];
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
  const firstSet = MODERATOR_TRANSCRIPT[0];
  if (!firstSet || firstSet.length < 2) return;
  // First bubble only: instant at 1s (do not advance moderatorSetIndex yet)
  emitModeratorMessage(session, firstSet[0], null, { instant: true })
    .then(() => {
      // Second bubble: normal thinking → typing → send (no bots in between)
      return emitModeratorMessage(session, firstSet[1], 1, { instant: false });
    })
    .then(() => {
      logLine("QUEUE", "moderator set 1 (Eunice intro) complete; starting bot loops");
      startNormalEnqueueLoop(session);
      startDequeueLoop(session);
    });
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
async function runMentionDetectors(session, newestMsg) {
  const text = newestMsg?.text || "";
  const speaker = newestMsg?.name || "";

  // Explicit @name (can be multiple)
  const explicit = detectExplicitMentions(text, session.botNames).filter((t) => t !== speaker);
  for (const target of explicit) {
    createMentionTicket(session, target, text, speaker || "unknown");
  }

  // Implicit (can return multiple targets, including "all")
  const implicitTargets = await detectImplicitMention({ history: session.history, botNames: session.botNames });
  if (Array.isArray(implicitTargets) && implicitTargets.length > 0) {
    for (const target of implicitTargets) {
      if (target && target !== speaker) {
        createMentionTicket(session, target, text, speaker || "unknown");
      }
    }
  }
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

    logLine("OPENAI_REQ_SYSTEM", sys);
    logLine("OPENAI_REQ_USER", userPrompt);

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
  // Fill slots up to MAX_ACTIVE_BOTS so interrupted/scheduled bots run with current history soon.
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

  // Interrupt applies to ALL messages (human "You", moderator Eunice, or any bot)—unchanged from before.
  interruptAllBotsOnNewMessage(session, { from: name, reason: "new_message" });
  if (!isIntroFirstBubbleOnly) {
    setImmediate(() => tryDequeueNow(session).catch(() => {}));
  }

  // Moderator directive updates directions; use first message for logic (commentary/nudge/directive)
  if (isModeratorMessage(firstNormalized)) {
    if (isIntroFirstBubbleOnly) {
      logLine("QUEUE", "moderator intro first bubble only: not enqueueing bots or next moderator set");
      // Do not enqueue directive or trySendNextModeratorSet; second bubble will be sent by sendFirstModeratorSetAfterLoad
    } else if (isCommentaryOnly(firstNormalized.text)) {
      logLine("QUEUE", `moderator commentary only: not updating directions`);
      runMentionDetectors(session, firstNormalized).catch(() => {});
    } else if (isModeratorNudge(firstNormalized.text)) {
      enqueueModeratorNudge(session, firstNormalized.text);
    } else {
      session.lastMajorModeratorMessageHistoryIndex = historyStart; // first message of this batch
      enqueueModeratorDirective(session, firstNormalized.text);
    }
  } else {
    runMentionDetectors(session, firstNormalized).catch(() => {});
    setImmediate(() => trySendNextModeratorSet(session));
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

  b.source = item.source || "normal";
  b.mentionId = item.mentionId || null;
  b.bubbles = [];
  b.idx = 0;
  b.sentCount = 0;
  b.finishCurrentThenStop = false;

  // Resolve priorityQ based on task type
  let priorityQuestion = null;
  let priorityMeta = null;
  
  if (b.source === "directive") {
    // Directive: use priorityQ from task
    priorityQuestion = item.priorityQ || null;
    priorityMeta = `This is a direct message from the moderator (${MODERATOR_NAME}). Respond to it directly.`;
  } else if (b.source === "mention") {
    // Mention: look up from mention ticket
    const t = session.pendingMentionByBot[botName];
    if (t && (!b.mentionId || t.id === b.mentionId)) {
      priorityQuestion = t.question;
      const msgsAgo = Math.max(0, session.history.length - 1 - t.anchorIndex);
      priorityMeta =
        `You were directly addressed earlier by ${t.askedBy} (${msgsAgo} messages ago). ` +
        `Answer that FIRST, then (optionally) react to the newest messages.`;
    } else {
      // Mention expired - skip this task
      logLine("QUEUE", `mention expired for bot=${botName} mentionId=${b.mentionId}`);
      setStage(session, botName, "IDLE");
      return;
    }
  }

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

      // After FIRST send, dequeue schedule + resolve mention
      if (b.sentCount === 0) {
        dequeueScheduleAfterFirstSend(session, botName);
        if (b.source === "mention") resolveMention(session, botName, b.mentionId);
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
        // Done
        b.bubbles = [];
        b.idx = 0;
        b.sentCount = 0;
        b.source = "normal";
        b.mentionId = null;
        setStage(session, botName, "IDLE");
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

              // done
              b.bubbles = [];
              b.idx = 0;
              b.sentCount = 0;
              b.source = "normal";
              b.mentionId = null;
              setStage(session, botName, "IDLE");
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
// Tickers
// =====================
function startNormalEnqueueLoop(session) {
  if (session.normalEnqueueTimer) clearInterval(session.normalEnqueueTimer);
  session.normalEnqueueTimer = setInterval(() => {
    enqueueNormalSpeaker(session);
  }, NORMAL_ENQUEUE_MS);
}

// =====================
// Human idle detection
// =====================
function isHumanIdle(session) {
  const now = Date.now();
  const timeSinceLastTyping = now - (session.humanLastTypingAt || 0);
  return timeSinceLastTyping > HUMAN_IDLE_MS;
}

function resetDequeueCounter(session) {
  session.dequeuedCountSinceHumanActive = 0;
}

// =====================
// Dequeue loop with human activity awareness
// =====================
function startDequeueLoop(session) {
  const tick = async () => {
    // Check if first item in queue is a directive - if so, bypass human idle rules
    const nextItem = nextScheduleItem(session);
    const isDirectiveFirst = nextItem?.source === "directive";
    
    if (isDirectiveFirst) {
      // Directive has priority - dequeue normally regardless of human idle state
      logLine("QUEUE", `directive first: bypassing human idle counter rules`);
      
      while (activeBotCount(session) < MAX_ACTIVE_BOTS) {
        const before = activeBotCount(session);
        await startBotJobIfPossible(session);
        const after = activeBotCount(session);
        if (after === before) break;
      }
      
      const wait = DEQUEUE_MIN_MS + Math.random() * (DEQUEUE_MAX_MS - DEQUEUE_MIN_MS);
      session.dequeueTimer = setTimeout(tick, wait);
      return;
    }

    const humanIdle = isHumanIdle(session);

    if (humanIdle) {
      // Human is idle: dequeue 3 messages spread across 10 seconds
      const messagesToDequeue = IDLE_DEQUEUE_COUNT;
      const totalSpread = IDLE_DEQUEUE_SPREAD_MS;
      
      // Generate random delays that sum to approximately totalSpread
      // Use a simple approach: divide into roughly equal parts with some randomness
      const delays = [];
      let remaining = totalSpread;
      for (let i = 0; i < messagesToDequeue - 1; i++) {
        // Each delay is a portion of remaining time with some randomness
        const portion = remaining / (messagesToDequeue - i);
        const delay = portion * (0.5 + Math.random() * 0.5); // 50-100% of portion
        delays.push(Math.max(100, delay)); // ensure minimum 100ms
        remaining -= delay;
      }
      delays.push(Math.max(100, remaining)); // last one gets the remainder

      // Shuffle delays for more natural distribution
      delays.sort(() => Math.random() - 0.5);

      logLine("QUEUE", `human idle: scheduling ${messagesToDequeue} messages over ${totalSpread}ms`);

      // Schedule messages with delays
      let cumulativeDelay = 0;
      for (let i = 0; i < messagesToDequeue; i++) {
        const delay = delays[i];
        cumulativeDelay += delay;
        
        setTimeout(async () => {
          // Check if still idle and can dequeue (but allow directives to bypass)
          const nextItem = nextScheduleItem(session);
          const isDirective = nextItem?.source === "directive";
          
          if (isDirective || (isHumanIdle(session) && activeBotCount(session) < MAX_ACTIVE_BOTS)) {
            const before = activeBotCount(session);
            await startBotJobIfPossible(session);
            const after = activeBotCount(session);
            if (after > before) {
              logLine("QUEUE", `human idle: dequeued message ${i + 1}/${messagesToDequeue}${isDirective ? " (directive)" : ""}`);
            }
          }
        }, cumulativeDelay);
      }

      // Reset counter after idle dequeues
      resetDequeueCounter(session);

      // Schedule next tick after all idle messages are scheduled
      const wait = totalSpread + DEQUEUE_MIN_MS;
      session.dequeueTimer = setTimeout(tick, wait);
    } else {
      // Human is active: limit to 3 messages
      let dequeuedThisTick = 0;
      
      while (
        activeBotCount(session) < MAX_ACTIVE_BOTS &&
        session.dequeuedCountSinceHumanActive < MAX_DEQUEUE_WHEN_HUMAN_ACTIVE
      ) {
        const before = activeBotCount(session);
        await startBotJobIfPossible(session);
        const after = activeBotCount(session);
        
        if (after > before) {
          session.dequeuedCountSinceHumanActive++;
          dequeuedThisTick++;
        } else {
          break; // No more bots can start
        }
      }

      if (session.dequeuedCountSinceHumanActive >= MAX_DEQUEUE_WHEN_HUMAN_ACTIVE) {
        logLine("QUEUE", `human active: reached max dequeue limit (${MAX_DEQUEUE_WHEN_HUMAN_ACTIVE})`);
      }

      const wait = DEQUEUE_MIN_MS + Math.random() * (DEQUEUE_MAX_MS - DEQUEUE_MIN_MS);
      session.dequeueTimer = setTimeout(tick, wait);
    }
  };

  if (session.dequeueTimer) clearTimeout(session.dequeueTimer);
  session.dequeueTimer = setTimeout(tick, DEQUEUE_MIN_MS);
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
    msgSeq: 0, // message sequence counter for TTL

    botNames,
    personasByHandle,

    // schedule + mention
    scheduleQueue: [], // { bot, source, mentionId?, createdAt?, priorityQ? }
    mentionQueue: [],
    pendingMentionByBot: {},

    // per-bot jobs
    bots: {},

    // loops
    normalEnqueueTimer: null,
    dequeueTimer: null,

    // human activity tracking
    humanLastTypingAt: Date.now(),
    dequeuedCountSinceHumanActive: 0,

    // moderator (Eunice) flow
    moderatorSetIndex: 0,
    lastModeratorMessageAt: 0,
    lastModeratorMessageHistoryIndex: -1,
    lastMajorModeratorMessageHistoryIndex: -1,
    lastModeratorDirectiveText: null,
    moderatorNudgeSentAfterLastMessage: false,
    moderatorTimer: null,

    // human participant display name (set by client via participant_name)
    participantName: null,
  };

  for (const b of botNames) ensureBot(session, b);

  logLine("SESSION_START", `id=${sessionId} condition=${condition} bots=${botNames.join(",")}`);

  socket.emit("session", { sessionId, condition, bots: botNames, moderatorName: MODERATOR_NAME });

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
    resetDequeueCounter(session);

    interruptAllBotsOnNewMessage(session, { from: humanName, reason: "new_human_message" });

    const msg = { name: humanName, text: t, ts: Date.now() };
    emitAndRecordMessage(session, msg);
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
