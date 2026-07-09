/**
 * It works
 * Study-chat server: moderator-led call-on flow.
 * No queue. Eunice (moderator) calls on one participant at a time; only that participant gets one OpenAI request (up to 3 messages).
 * Human turn: moderator advances only when human has sent at least 1 message AND is idle. Idle thresholds come from IDLE_EMPTY_MS / IDLE_TYPING_MS below.
 * After first round: detect view misalignments (disagreedWith/disagreedBy/differenceSummary), then prompt each "person to ask" to respond (one OpenAI call per).
 */

import "dotenv/config";
import express from "express";
import fs from "fs";
import crypto from "crypto";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import bcrypt from "bcrypt";
import zxcvbn from "zxcvbn";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
// mysql2 loaded lazily — see DB section below
import {
  getCastByHandles,
  systemPrompt,
  buildUserPrompt,
} from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bot names from CLI: npm start -- Anthony Mina Sid (optional; if empty, use the group-rotation cast)
const CLI_BOT_NAMES = process.argv
  .slice(2)
  .map((s) => String(s).trim())
  .filter(Boolean);

// =====================
// Logging (per-run log file)
// =====================
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

function clip(s, maxLen = 120) {
  const t = String(s ?? "").trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen) + "…";
}

/** Path of the per-session transcript file (also used for the header write on session start). */
function transcriptPathFor(session) {
  return path.join(LOG_DIR, `t_${session.assignedGroup || "cli"}_${session.humanDisplayName || session.participantName}_${runStamp}_${session.sessionId}.txt`);
}

/** Append one line to the session transcript file (same pattern as log file). */
function appendTranscriptLine(session, name, text) {
  if (!session?.sessionId) return;
  const transcriptPath = transcriptPathFor(session);
  const line = `${name}: ${String(text ?? "").trim()}\n`;
  try {
    fs.appendFileSync(transcriptPath, line, "utf8");
  } catch (e) {
    console.error("Transcript append failed", e?.message);
  }
}

function logLine(tag, message) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const line = `${ts} [${tag}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("Log write failed", e?.message);
  }
  console.log(line.trim());
}

// =====================
// Constants – All timing / delay values in one place
// =====================

// --- Human idle detection ---
const IDLE_EMPTY_MS = 3000;                   // Human stopped typing with empty input → considered idle after this
const IDLE_TYPING_MS = 4000;                 // Human stopped typing with non-empty input → considered idle after this
const IDLE_CHECK_MS = 2000;                   // How often the server polls to check if human is idle

// --- Nudge (remind inactive human) ---
const NUDGE_MS = 20000;                       // Nudge after this long with no typing (empty input)
const NUDGE_AFTER_TYPING_WITH_DRAFT_MS = 30000; // Nudge after this long with no typing (has draft in input)
const MAX_NUDGES = 3;                         // Kick user after this many unanswered nudges (nudge 1 & 2 are reminders, nudge 3 kicks)

// --- Elaboration ("Could you elaborate?") ---
const MAX_ELABORATION_NUDGES = 4;             // Kick user after this many elaboration prompts with no substantive response
const ELABORATION_WAIT_MS = 5000;             // Wait this long after human goes idle before asking to elaborate

// --- Bot message timing ---
const BOT_THINK_DELAY_MS = { min: 4000, max: 6000 }; // Pause before bot shows "typing…" indicator
// Poll-specific silent think before a bot starts typing its poll answer. Longer
// than the call-on think: a short yes/no landing 4s after the question reads as
// bot-like, and the wider range spreads the three bots apart instead of all
// starting to type at once. The OpenAI call still runs hidden inside this delay.
// Keep max + type-out comfortably under POLL_STRAGGLER_GRACE_MS (15s).
const POLL_BOT_THINK_DELAY_MS = { min: 3000, max: 6000 };
// Silent "reading" pause before the bot's study-goal ack ("Ok!") starts typing.
// No upper-bound constraint: the first question's SEND is gated on the ack emit
// (bounded promise in runStudyGoal → startFirstRound's holdFirstEmitFor), so the
// ack always lands first by construction — tune this freely. Only soft limit:
// past ~7.5s total (pre-delay + type-out) the 10s hold cap could truncate.
const STUDY_GOAL_ACK_PRE_DELAY_MS = { min: 2200, max: 3200 };
// Minimum visible gap between a gating ack and the moderator message whose send
// waits on it (study-goal "Ok!" → first question; Mina's passkey follow-up →
// poll summary). The gap timer starts the moment the ack LANDS (eager promise
// chain), so it adds nothing when the ack arrived before the type-out finished —
// it only prevents the two messages from posting in the same instant.
const POST_ACK_SEND_GAP_MS = { min: 600, max: 800 };
const POLL_STRAGGLER_GRACE_MS = 15000;        // After the human finishes a poll, max wait for slow bots before sending the summary anyway
const TYPING_SPEED = { min: 0.8, max: 1.4 };  // Bot typing speed range (words/sec) ≈ 48–84 WPM — human texting pace
const EXPLANATORY_TYPING_DELAY_MS = { min: 3000, max: 5000 };  // Moderator explanatory broadcasts (intro, study goal, poll instructions, polls, first big question, wrap-up) — FIXED type delay regardless of length. Human-paced moderator messages (reactions, summaries, discussion prompts, final big question) instead type at the length-based TYPING_SPEED.
const MODERATOR_THINK_DELAY_MS = { min: 3000, max: 5000 };       // Moderator think delay before typing
const MODERATOR_CONSECUTIVE_DELAY_MS = { min: 500, max: 1500 };  // Shorter delay between consecutive moderator messages


// --- Poll answer style ---
const POLL_EXPLAIN_PROBABILITY = 0.4;         // Chance a bot's poll answer includes a short reason (Variant B, "explain") instead of a bare yes/no (Variant A, "simple")
const POLL_SUMMARY_TO_NEXT_PAUSE_MS = { min: 1000, max: 2000 }; // Breather after the poll summary posts before Eunice's next-question flow (its own think delay) starts — back-to-back felt too quick

// --- Disagreement follow-ups ---
const MAX_DISAGREEMENT_FOLLOWUPS = 1;         // How many disagreement questions the moderator asks (all misalignments are still detected, but only this many are discussed)

// --- Kick delays ---
const KICK_DISPLAY_MS = 1500;                 // How long the kick message is visible before emitting the kick event
const INAPPROPRIATE_KICK_DELAY_MS = 1000;     // Delay before kicking for inappropriate content
const MODERATOR_NAME = "Eunice";

/** Capitalize first character of a name. */
function capitalizeFirst(s) {
  if (!s || typeof s !== "string") return s ?? "";
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
}

/**
 * Name to use when referring to the human WITHOUT @ (introduced name if available, else display name).
 * For @ mentions, always use session.humanDisplayName.
 */
function getHumanReferenceName(session) {
  if (!session?.participantName) return "You";
  const base = session.introducedName ?? session.participantName;
  return capitalizeFirst(base);
}

const MODERATOR_SCRIPT_DEFAULT = [
  {
    type: "intro",
    messages: [
      "Hi everyone! My name is Eunice, and I'll be moderating today's discussion. Thanks for joining!",
      "To start us off, can we go around and do quick introductions? You can just share your name and anything you feel like mentioning.",
    ],
  },
  {
    type: "study_goal",
    messages: [
      "Before we dive in, just a quick note about the goal of this study. We are interested in how people experience new features introduced by large tech companies, and how they decide whether to adopt them or not.",
      "We will go one at a time, so please respond when I call your name. \n\nThere are no right or wrong answers. Just share your honest experiences with technology",
    ],
  },
  {
    type: "big_question",
    messages: [
      "First question: Tech companies often roll out new features in apps you already use, like a redesigned layout, a new tool or button, or new AI features.\n\nWhen something new like that shows up, how do you usually feel? Do you try it right away, or ignore it at first?",
    ],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about VPN?"],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about password managers?"],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about passkeys?"],
  },
  {
    type: "big_question",
    messages: [
      "Since some of you have already come across passkeys, I'd love to dig into that a bit. If you've tried one, how did it go, and would you keep using it? If you haven't, what's your gut reaction to the idea of switching to one?",
    ],
  },
];

const MODERATOR_SCRIPT_CONTROL = [
  {
    type: "intro",
    messages: [
      "Hi everyone! My name is Eunice, and I'll be moderating today's discussion. Thanks for joining!",
      "To start us off, can we go around and do quick introductions? You can just share your name and anything you feel like mentioning.",
    ],
  },
  {
    type: "study_goal",
    messages: [
      "Before we dive in, just a quick note about the goal of this study. We are interested in how people experience new features introduced by large tech companies, and how they decide whether to adopt them or not.",
      "We will go one at a time, so please respond when I call your name. \n\nThere are no right or wrong answers. Just share your honest experiences with technology",
    ],
  },
  {
    type: "big_question",
    messages: [
      "First question: Tech companies often roll out new features in apps you already use, like a redesigned layout, a new tool or button, or new AI features.\n\nWhen something new like that shows up, how do you usually feel? Do you try it right away, or ignore it at first?",
    ],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about VPN?"],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about password managers?"],
  },
  {
    type: "poll",
    messages: ["Have you ever used or heard about generative AI?"],
  },
  {
    type: "big_question",
    messages: [
      "Since some of you have already come across generative AI tools, I'd love to dig into that a bit. If you've tried one, how did it go, and would you keep using it? If you haven't, what's your gut reaction to the idea of trying one?",
    ],
  },
];

function getModeratorScript(group) {
  return group === "control" ? MODERATOR_SCRIPT_CONTROL : MODERATOR_SCRIPT_DEFAULT;
}

const STUDY_GOAL_ACKS = ["Got it!", "Ok!", "Sure!"];

// 25s timeout per call so a single stuck completion can't freeze the call-on round
// for the SDK default of 10min. Real 429 retry-after waves (~20s) still fit; longer
// hangs throw and each caller's try/catch falls back to a default line.
const OPENAI_TIMEOUT_MS = 25000;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
});

// Verbosity for OpenAI prompt logging. Default 600 chars per prompt; tune via env
// if a prompt is being truncated mid-instruction. Output is always logged in full
// (clip length 600 too) so you can see what the LLM actually returned.
const OPENAI_LOG_LEN = Number(process.env.OPENAI_LOG_LEN || 600);

/**
 * Wrapped chat-completion call that logs purpose, model, params, prompts, output
 * and rtt for every OpenAI request. `purpose` is a short tag like "moderator_cue:mid_round"
 * — make it specific enough that you can grep the log to find one prompt path.
 */
async function loggedOpenAI(purpose, params) {
  const start = Date.now();
  const sysMsg = params.messages?.find((m) => m.role === "system")?.content || "";
  const userMsg = params.messages?.find((m) => m.role === "user")?.content || "";
  logLine(
    "OPENAI_REQ",
    `[${purpose}] model=${params.model} temp=${params.temperature ?? "?"} max_tokens=${params.max_tokens ?? "?"}`
  );
  logLine("OPENAI_SYS", `[${purpose}] ${clip(sysMsg, OPENAI_LOG_LEN)}`);
  logLine("OPENAI_USR", `[${purpose}] ${clip(userMsg, OPENAI_LOG_LEN)}`);
  try {
    const completion = await openai.chat.completions.create(params);
    const out = completion?.choices?.[0]?.message?.content ?? "";
    logLine(
      "OPENAI_OK",
      `[${purpose}] rtt=${Date.now() - start}ms out=${clip(out, OPENAI_LOG_LEN)}`
    );
    return completion;
  } catch (e) {
    logLine("OPENAI_ERR", `[${purpose}] rtt=${Date.now() - start}ms err=${e?.message || e}`);
    throw e;
  }
}
let MODELS = { default: "gpt-4o-mini" };
try {
  const raw = fs.readFileSync(path.join(__dirname, "models.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.default) MODELS.default = parsed.default;
} catch (e) {
  console.warn("Using default gpt-4o-mini (models.json not found or invalid)");
}

// =====================
// MySQL Database (lazy-loaded so server starts even if mysql2 is missing)
// =====================
let dbPool = null;
(async () => {
  logLine("DB", "=== DATABASE INIT START ===");
  logLine("DB", `DB_HOST=${process.env.DB_HOST || "(not set)"} DB_PORT=${process.env.DB_PORT || "(not set)"} DB_USER=${process.env.DB_USER || "(not set)"} DB_NAME=${process.env.DB_NAME || "(not set)"} DB_PW=${process.env.DB_PW ? "(set)" : "(NOT SET)"}`);
  try {
    logLine("DB", "importing mysql2/promise...");
    const mysql = await import("mysql2/promise");
    logLine("DB", "mysql2 imported successfully, creating connection pool...");
    dbPool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || "focusgroupcc",
      password: process.env.DB_PW || "",
      database: process.env.DB_NAME || "focusgroupcc_",
      waitForConnections: true,
      connectionLimit: 5,
    });
    logLine("DB", "pool created, executing CREATE TABLE...");
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS participant_responses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(100) NOT NULL,
        participant_id VARCHAR(100) NOT NULL,
        q1_new_features TEXT,
        q2_vpn TEXT,
        q3_password_managers TEXT,
        q4_passkeys_heard TEXT,
        q5_passkey_switch TEXT,
        auth_choice ENUM('password', 'passkey') DEFAULT NULL,
        assigned_group ENUM('pro', 'anti', 'half', 'cont') DEFAULT NULL,
        bots_config VARCHAR(255) DEFAULT NULL,
        prolific_pid VARCHAR(100) DEFAULT NULL,
        prolific_study_id VARCHAR(100) DEFAULT NULL,
        prolific_session_id VARCHAR(100) DEFAULT NULL,
        dur_opening_ms INT DEFAULT NULL,
        dur_focus_group_ms INT DEFAULT NULL,
        dur_auth_selection_ms INT DEFAULT NULL,
        dur_auth_creation_ms INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_session_participant (session_id, participant_id)
      )
    `);
    // Ensure columns/keys exist for tables created before these were added
    await dbPool.execute(`
      ALTER TABLE participant_responses
        MODIFY COLUMN assigned_group ENUM('pro', 'anti', 'half', 'cont') DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD UNIQUE INDEX IF NOT EXISTS uq_session_participant (session_id, participant_id)
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS bots_config VARCHAR(255) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS prolific_pid VARCHAR(100) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS prolific_study_id VARCHAR(100) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS prolific_session_id VARCHAR(100) DEFAULT NULL
    `).catch(() => {});
    // Registration flow columns on participant_responses (single table)
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS password_strength TINYINT DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS webauthn_credential JSON DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS webauthn_challenge VARCHAR(255) DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS session_token VARCHAR(255) DEFAULT NULL
    `).catch(() => {});
    // Records which auth method was rendered on top of the SecureStep card list
    // (alternated per-participant by the server). Value: "password" or "passkey".
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS auth_method_top VARCHAR(16) DEFAULT NULL
    `).catch(() => {});
    // Ordered log of every method card the user clicked on SecureStep, including
    // back-and-forth switches, e.g. ["passkey","password","passkey"]. JSON array.
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS auth_method_clicks JSON DEFAULT NULL
    `).catch(() => {});
    // Funnel stage durations (milliseconds). dur_opening_ms = app opened → chat
    // start (measured on the client's clock, so no cross-clock skew);
    // dur_focus_group_ms = chat start → wrap-up or kick (server-side);
    // dur_auth_selection_ms = password/passkey cards shown → LAST method-card click
    // (changing one's mind counts as still selecting);
    // dur_auth_creation_ms = last method click → successful registration
    // (both measured client-side in SecureStep and sent with the existing requests).
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS dur_opening_ms INT DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS dur_focus_group_ms INT DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS dur_auth_selection_ms INT DEFAULT NULL
    `).catch(() => {});
    await dbPool.execute(`
      ALTER TABLE participant_responses
        ADD COLUMN IF NOT EXISTS dur_auth_creation_ms INT DEFAULT NULL
    `).catch(() => {});
    logLine("DB", "=== DATABASE INIT SUCCESS — participant_responses table ready ===");
  } catch (e) {
    logLine("DB_ERROR", `=== DATABASE INIT FAILED: ${e?.message} ===`);
    logLine("DB_ERROR", `Full error: ${JSON.stringify(e, Object.getOwnPropertyNames(e || {}))}`);
    dbPool = null;
  }
})();

// =====================
// Helpers
// =====================
function parseJsonArray(rawText, maxItems = 3) {
  if (!rawText) return [];
  let s = String(rawText).trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  function tryParse(str) {
    try {
      const parsed = JSON.parse(str);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((x) => (typeof x === "string" ? x : String(x ?? "").trim()).replace(/---/g, "").trim())
        .filter(Boolean)
        .map((x) => x.slice(0, 220))
        .slice(0, maxItems);
    } catch {
      return null;
    }
  }
  let result = tryParse(s);
  if (result) return result;
  const arrayMatch = s.match(/\[\s*[\s\S]*?\]/);
  if (arrayMatch) {
    result = tryParse(arrayMatch[0]);
    if (result) return result;
  }
  return s ? [s.replace(/---/g, "").trim().slice(0, 220)] : [];
}

// =====================
// Bot response (one OpenAI request → 1–3 messages)
// =====================
async function getBotResponse(botName, context) {
  const { moderatorQuestion, directive, previousAnswers, session, roundType = "big_question" } = context;
  const humanRefName = getHumanReferenceName(session);
  const botId = session?.botIdMap?.[botName] || botName;
  const cast = getCastByHandles([botId]);
  const persona = cast[0] || {};
  const bots = context.bots || [botName];
  const others = bots.filter((n) => n !== botName).join(", ") || "others";

  const sys = systemPrompt(
    botName,
    others,
    persona,
    MODERATOR_NAME,
    humanRefName
  );

  // Build prior context: include moderator explanations from earlier rounds
  // so bots remember what was already explained (e.g. passkey definition).
  const priorContextLines = [];
  if (session?.messages) {
    const currentRoundMsgs = new Set(previousAnswers.map(a => `${a.name}:${a.text}`));
    for (const m of session.messages) {
      const key = `${m.name}:${m.text}`;
      if (currentRoundMsgs.has(key)) break; // stop when we hit current round
      // Include moderator messages (explanations) and bot's own previous answers
      if (m.name === MODERATOR_NAME || m.name === botName) {
        priorContextLines.push(`${m.name}: ${m.text}`);
      }
    }
  }
  const priorContext = priorContextLines.length > 0
    ? `--- Earlier discussion context ---\n${priorContextLines.join("\n")}\n--- Current round ---\n`
    : "";

  const transcriptLines = [];
  transcriptLines.push(`${MODERATOR_NAME}: ${moderatorQuestion}`);
  for (const a of previousAnswers) {
    transcriptLines.push(`${a.name}: ${a.text}`);
  }
  if (directive) {
    transcriptLines.push(`${MODERATOR_NAME}: ${directive}`);
  }
  const transcript = priorContext + transcriptLines.join("\n");

  const recentBot = previousAnswers
    .filter((a) => a.name !== botName)
    .map((a) => a.text)
    .join(" | ") || "(none)";

  // Determine if bot messages should be shortened:
  // - Control group: shorten ALL big_question rounds
  // - Pro/anti groups: shorten only the first big_question (general new-feature question)
  const group = session?.assignedGroup;
  const isFirstBigQuestion = session?.currentRoundIndex === 0
    && session?.allRounds?.[0]?.type === "big_question";
  const shorten = roundType !== "poll" && (
    group === "control" ||
    ((group === "pro" || group === "anti") && isFirstBigQuestion)
  );

  const maxBubbles = roundType === "poll" ? 1 : shorten ? 2 : Math.min(3, Math.max(1, Number(persona.max_bubbles) || 3));

  // Poll answers per bot: POLL_EXPLAIN_PROBABILITY (40%) chance of a short
  // yes/no + reason under 10 words (Variant B), else a bare yes/no (Variant A).
  // Both stay in the persona's voice.
  const pollExplain = roundType === "poll" ? Math.random() < POLL_EXPLAIN_PROBABILITY : false;

  const userPrompt = buildUserPrompt({
    transcript,
    recentBot,
    recentQs: moderatorQuestion,
    mode: "human",
    botName,
    otherName: others,
    respondTo: directive ? { type: "directive", text: directive } : null,
    moderatorName: MODERATOR_NAME,
    maxBubbles,
    questionType: roundType,
    shorten,
    pollExplain,
  });

  const pollModeTag = roundType === "poll" ? (pollExplain ? ":explain" : ":simple") : "";
  const completion = await loggedOpenAI(`bot_response:${botName}:${roundType}${pollModeTag}`, {
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
    max_tokens: roundType === "poll" ? 120 : shorten ? 200 : maxBubbles <= 2 ? 400 : 600,
    temperature: 0.7,
  });

  const raw = completion?.choices?.[0]?.message?.content ?? "";
  return parseJsonArray(raw, maxBubbles);
}

// =====================
// Disagreement detection (OpenAI)
// =====================
async function detectDisagreements(moderatorQuestion, answersByPerson) {
  const lines = [`Moderator question: ${moderatorQuestion}`];
  for (const [name, texts] of Object.entries(answersByPerson)) {
    const full = Array.isArray(texts) ? texts.join(" ") : String(texts);
    lines.push(`${name}: ${full}`);
  }
  const transcript = lines.join("\n");
  logLine("DISAGREEMENT CHECK", transcript);

  const sys = `You analyze discussion transcripts.

Your task is to identify VIEW MISALIGNMENT (stance divergence), not interpersonal disagreement.

Definition of VIEW MISALIGNMENT:
Two or more participants express substantively different positions, attitudes, or preferences about the same topic — even if they do not directly respond to each other.
However, if one participant explicitly said that they don't know or don't have an opinion, that does not count as a view misalignment.

This includes:
- One participant expressing strong resistance while another expresses openness.
- One expressing skepticism while another expresses enthusiasm.
- One prioritizing security while another dismisses security.
- Any meaningful contrast in stance, even if no one explicitly disagrees.

This does NOT include (do NOT count as view misalignment):
- One of the participants expressing confusion, no strong stance, or no opinion, ambivalent, or neutral.

This does NOT require:
- Direct replies to each other.
- Explicit phrases like “I disagree”.
- Pushback or confrontation.

The value of disagreedWith must refer to a participant who spoke before the participant identified as disagreedBy in the transcript order.

For every pair of participants whose views differ meaningfully, output an object:

{
  "disagreedWith": "Name",
  "disagreedBy": "Name",
  "differenceSummary": "Brief explanation of how their views differ"
}

Output a separate object for each pair whose views differ. If multiple participants share a similar stance that contrasts with another participant, include each such pair (e.g. if both Sid and Anthony contrast with Vivian, output both Sid–Vivian and Anthony–Vivian).

Use EXACT names as they appear in the transcript.

If all participants express essentially the same stance, output: [].

Output ONLY valid JSON. No extra text.`;

  const completion = await loggedOpenAI("detect_disagreement", {
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: transcript },
    ],
    max_tokens: 800,
    temperature: 0,
  });

  const raw = completion?.choices?.[0]?.message?.content ?? "[]";
  logLine("DISAGREEMENT CHECK RESULT", raw);
  let arr = parseDisagreementJson(raw);
  return arr.filter(
    (x) =>
      x &&
      typeof x.disagreedWith === "string" &&
      typeof x.disagreedBy === "string" &&
      typeof x.differenceSummary === "string"
  );
}

/** Parse view-misalignment JSON; on truncation, try closing the last string/array and re-parse. */
function parseDisagreementJson(raw) {
  const s = String(raw ?? "").replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!s.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const closed = s.replace(/,?\s*$/, "") + "\"]}";
    try {
      const parsed = JSON.parse(closed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

// =====================
// Generate follow-up prompt for disagreed-with person (view-misalignment wording)
// =====================
async function generateDisagreementFollowUp(disagreedWith, disagreedBy, disagreedByText, moderatorQuestion, differenceSummary) {
  const fallback = `It sounds like there are a couple different takes here — @${disagreedWith}, what are your thoughts?`;
  const sys = `You are a casual, neutral human discussion moderator. You've noticed participants have different views on a topic. Write 1-2 short sentences that:

1. Briefly and neutrally observe the difference WITHOUT directly pitting people against each other (e.g. "It sounds like we're hearing a couple different approaches..." or "Interesting — seems like people feel differently about this...")
2. Then naturally invite ${disagreedWith} to share more (e.g. "...@${disagreedWith}, what are your thoughts?" or "...curious what you think, @${disagreedWith}")

IMPORTANT: When mentioning any participant by name, ALWAYS prefix their name with @ (e.g. @Anthony, @Mina). Every single name mention must have the @ prefix.
- Do NOT say "what do you think about @[Name]'s approach/view/idea?" — that's too confrontational
- Do NOT frame it as a direct disagreement or conflict
- Keep it neutral, warm, and organic — like you're genuinely curious, not forcing a debate
- You MUST include @${disagreedWith}'s name (with @ prefix)
- Sound like a real person, not a formal moderator

Context: The discussion question was: "${moderatorQuestion}". ${disagreedBy} said: "${(disagreedByText || "").slice(0, 200)}". The difference: ${(differenceSummary || "").slice(0, 200)}.
Output ONLY the message text. No quotes, no JSON, no separators.`;

  const completion = await loggedOpenAI(`disagreement_followup:${disagreedWith}`, {
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "Generate the follow-up sentence." },
    ],
    max_tokens: 120,
    temperature: 0.7,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  const out = text || fallback;
  if (!out.toLowerCase().includes(disagreedWith.toLowerCase())) return fallback;
  return out;
}

/** Generate a moderator summary of the round. Pass opts.roundType to control behavior per question type. */
async function generateRoundSummary(question, roundTranscript, opts = {}) {
  const { roundType = "big_question" } = opts;
  const sys = roundType === "poll"
    ? `You are Eunice, a warm, professional-but-friendly discussion moderator. Given this poll question and the short answers, write ONE bubble that acknowledges HOW MANY people had experience with the topic.

RULES:
- Under 12 words. One sentence. Warm and upbeat, but not overly casual.
- Use FUZZY quantifiers ("everyone", "most of you", "some of you", "nobody"). NEVER give exact counts ("2 of you", "3 out of 4").
- If someone said they've USED it → they've used it.
  If someone said they've HEARD of it but not used → heard of it, NOT used.
  If someone asked what it is or said they don't know → they don't know it.
  Don't collapse these three.
- Vary the opener: "Great!", "Oh nice!", "Interesting!", "Cool!", "Perfect!", "Oh got it,", "Wonderful,", "Awesome!"
- NEVER use "haha", "lol", "hmm", or filler laughs.
- DO NOT add opinions about the tech itself.

Examples of good output:
- "Oh nice! Sounds like everyone here uses one."
- "Interesting, most of you have tried it!"
- "Cool, looks like a bit of a mix here!"
- "Oh got it, some of you haven't heard of it yet."
- "Great, sounds like nobody's really used it yet!"

Output only the sentence, no quotes or extra text.`
    : `You are a casual human discussion moderator wrapping up a round. Write 1-2 short sentences that briefly capture what people said. Sound like a real person — warm but concise. If people had different takes, note it naturally (e.g. "Sounds like some of you are more cautious while others jump right in"). Do NOT list everyone's individual views. Keep it under 30 words. Output ONLY the text, no quotes or formatting.`;
  const completion = await loggedOpenAI(`round_summary:${roundType}`, {
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Question: ${question}\n\n${roundTranscript}` },
    ],
    max_tokens: roundType === "poll" ? 60 : 200,
    temperature: 0.7,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  return text || (roundType === "poll" ? "Thanks everyone for the quick answers!" : "Thanks everyone for sharing your views on that.");
}

/**
 * Extract the name the human introduced themselves as from their intro message(s).
 * Returns the introduced name or null if none found.
 */
async function extractIntroducedName(introMessages, displayName) {
  const text = Array.isArray(introMessages) ? introMessages.join(" ") : String(introMessages || "");
  if (!text.trim()) return null;
  const sys = `You extract the name a person introduced themselves as from their message. Return ONLY valid JSON: {"name": "..."} with the name they gave, or {"name": null} if they did not mention a name.
Examples:
- "hello everyone, my name is tony" → {"name": "Tony"}
- "hey im tony, nice to meet yall" → {"name": "Tony"}
- "hi I go by T" → {"name": "T"}
- "hey everyone! excited to be here" → {"name": null}
- "my name is Tony Park and I work in tech" → {"name": "Tony"}
Return ONLY the first name they introduced themselves as, capitalized. If they didn't say a name, return null.`;
  const user = `Their display name is "${displayName}". Their message: "${text.trim().slice(0, 400)}"`;
  try {
    const completion = await loggedOpenAI("extract_intro_name", {
      model: MODELS.default,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 30,
      temperature: 0,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw || "{}");
    if (parsed.name && typeof parsed.name === "string") return parsed.name.trim();
  } catch (e) {
    console.error("extractIntroducedName error", e?.message || e);
  }
  return null;
}

/**
 * True if the participant's message is a genuine self-introduction (shares a name
 * and/or something about themselves), not just a bare greeting like "hi".
 * Fails closed (returns false) on error so a classifier hiccup never lets a bare
 * greeting slip through; the idle nudge will keep prompting a legitimate user.
 */
async function isIntroSufficient(introText) {
  const trimmed = String(introText || "").trim();
  if (!trimmed) return false;
  const sys = `You decide whether a chat message is a genuine self-introduction or greeting in a group discussion. The participant was asked to introduce themselves and share their name and anything they'd like. Be lenient: accept any sincere attempt to greet or engage the group, even without an explicit name. Return ONLY valid JSON: {"introduced": true} or {"introduced": false}.
- true: they share their name, share something about themselves, OR greet/engage the group socially (e.g. "I'm Ana", "Hey, I'm Ana and I work in tech", "Hi I go by T, excited to be here", "hi everyone, nice to meet you all", "hey all, happy to be here", "this is Test, nice to meet you all").
- false: ONLY a bare one-word greeting or filler with nothing else added (e.g. "hi", "hello", "hey", "yo", "sup", "ok").`;
  const user = `Message: "${trimmed.slice(0, 400)}"`;
  try {
    const completion = await loggedOpenAI("is_intro_sufficient", {
      model: MODELS.default,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 20,
      temperature: 0,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return !!parsed.introduced;
  } catch (e) {
    console.error("isIntroSufficient error", e?.message || e);
    return false;
  }
}

/**
 * Evaluate the human's intro messages so far. Records the introduced name on the
 * session as a side effect, and returns true only if the intro is sufficient
 * (a name was given, or the reply is a real self-introduction rather than a bare greeting).
 */
async function evaluateHumanIntro(session) {
  const introText = (session?.humanMessagesThisRound || []).join(" ").trim();
  if (!introText) return false;
  // Sufficiency is decided ONLY by isIntroSufficient. Do NOT use name extraction as the
  // gate: extractIntroducedName is given the display name in its prompt and will sometimes
  // echo it back even for a bare greeting (e.g. "hi" → display name), which would wrongly
  // advance past the intro.
  const sufficient = await isIntroSufficient(introText);
  logLine("QUEUE", `intro check: "${clip(introText, 80)}" sufficient=${sufficient}`);
  if (!sufficient) return false;
  // Real introduction — now capture the name they gave (if any) for later reference.
  const introduced = await extractIntroducedName(introText, session.humanDisplayName);
  if (introduced && introduced.toLowerCase() !== session.participantName.trim().toLowerCase()) {
    session.introducedName = introduced.trim();
    logLine("QUEUE", `intro: using introduced name "${session.introducedName}" when referring (NamePage had "${session.participantName}")`);
  }
  return true;
}

/** True if the participant's message indicates they don't know what passkey is and are asking for an explanation. */
async function isAskingWhatPasskeyIs(text, roundQuestion) {
  if (!text || !String(text).trim()) return false;
  const trimmed = String(text).trim();
  const sys = `You classify whether a chat message indicates the participant does NOT know what passkey is and is asking for an explanation. Return ONLY valid JSON: {"asksWhatPasskeyIs": true} or {"asksWhatPasskeyIs": false}. True when: asks what passkey is, expresses confusion, requests explanation. False when: already knows, sharing opinion.`;
  const user = `Round: ${String(roundQuestion ?? "").slice(0, 150)}\nMessage: "${trimmed.slice(0, 300)}"\nDoes this indicate they don't know passkey and want explanation?`;
  try {
    const completion = await loggedOpenAI("is_asking_passkey", {
      model: MODELS.default,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 20,
      temperature: 0,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return !!parsed.asksWhatPasskeyIs;
  } catch (e) {
    console.error("isAskingWhatPasskeyIs error", e?.message || e);
    return false;
  }
}

/**
 * Two parallel API calls to classify a participant's message:
 *   isQuestion   — based on burst text only (messages since last moderator response).
 *   substantive  — based on combined round text.
 *   inappropriate — based on combined round text.
 *
 * All three are computed in ONE OpenAI call (previously two parallel calls). The
 * burst/combined distinction is preserved by passing both texts and telling the
 * model which one each field is keyed off of.
 */
async function classifyHumanMessage(burstText, combinedText, context, roundQuestion) {
  if (!burstText || !String(burstText).trim()) return { isQuestion: false, substantive: false, inappropriate: false };
  const combined = combinedText || burstText;

  const combinedWordCount = String(combined).trim().split(/\s+/).filter(Boolean).length;
  const forcedSubstantive = combinedWordCount > 10 ? true : combinedWordCount <= 2 ? false : null;

  const { type = "call_on", prompt = "" } = context || {};
  const qContext = `Prompt type: ${type}\nDiscussion question: "${String(roundQuestion ?? "").slice(0, 200)}"\nPrompt shown to participant: "${String(prompt || "").slice(0, 300)}"`;

  const sys = `You are a strict classifier. Return ONLY valid JSON with THREE boolean fields:

- "isQuestion": Look ONLY at the BURST text. True ONLY if the burst contains an explicit, direct question directed at the moderator asking for clarification or explanation. Must contain a clear question form (e.g. "what is X?", "can you explain X?", "how does X work?"). False for: filler ("ok","idk","nope","not sure"), emotions, statements, opinions, expressions of uncertainty or confusion ("I'm not sure what X is", "I don't really know about X", "never heard of X"), or anything that tries to answer the prompt. Uncertainty or lack of knowledge is NOT a question — they must be explicitly asking.

- "substantive": Look at the COMBINED text. True if the messages give ANY genuine answer to the prompt — an experience, opinion, or thought, OR an honest statement that they don't know / have never heard of / aren't familiar with the topic (e.g. "I've never heard of them", "I don't really know what that is", "no idea, never used it"). Those ARE complete, valid answers — do NOT treat them as needing elaboration. Be lenient. Set false ONLY for pure filler with no actual answer ("ok", "idk", "sure", "lol", "hmm"), off-topic content, or messages that are only a question.

- "inappropriate": Look at the COMBINED text. True if the messages are clearly inappropriate — aggressive, hostile, offensive, sexual, nonsensical gibberish, or wildly off-topic. Normal short or vague answers are NOT inappropriate.

Return format: {"isQuestion": true/false, "substantive": true/false, "inappropriate": true/false}`;

  const user = `${qContext}

BURST (recent messages since last moderator response): "${String(burstText).trim().slice(0, 400)}"

COMBINED (all participant messages this round): "${String(combined).trim().slice(0, 800)}"`;

  try {
    const completion = await loggedOpenAI("classify_human_message", {
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 40,
      temperature: 0,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(raw || "{}");
    return {
      isQuestion: !!parsed.isQuestion,
      substantive: forcedSubstantive !== null ? forcedSubstantive : !!parsed.substantive,
      inappropriate: !!parsed.inappropriate,
    };
  } catch (e) {
    console.error("classifyHumanMessage error", e?.message || e);
    return { isQuestion: false, substantive: forcedSubstantive ?? false, inappropriate: false };
  }
}

/**
 * Generate a moderator answer to a question.
 * - If alreadyAnswered contains a similar topic: returns 1 short string (≤8 words).
 * - Otherwise: returns 2 strings [full answer, question reminder].
 * alreadyAnswered is an array of { question, answer } objects from this session.
 */
async function generateModeratorQuestionAnswer(questionText, roundQuestion, alreadyAnswered = []) {
  const fallback = ["Great question! I'm happy to clarify."];

  const previousCtx = alreadyAnswered.length > 0
    ? `\n\nPreviously answered questions this session:\n${alreadyAnswered
        .map((a, i) => `${i + 1}. Q: "${a.question.slice(0, 120)}" → A: "${a.answer.slice(0, 120)}"`)
        .join("\n")}`
    : "";

  const sys = `You are ${MODERATOR_NAME}, a warm and natural HUMAN discussion moderator. A participant has asked a question.${previousCtx}

If the participant's question is asking about a topic you already answered above (same concept, even if worded differently), respond with ONE short sentence (up to ~15 words) that BOTH acknowledges you answered it earlier AND gives a brief one-line reminder of the answer. Examples: "Like I mentioned above, it's a passwordless way to log in using your biometrics." / "As I said earlier, it lets you sign in with your face or fingerprint instead of a password." Return a JSON array with exactly 1 string.

Otherwise (new topic not yet covered), respond with EXACTLY a JSON array of 1 string:
1. Answer the question naturally in at most 2 short sentences. Be casual and direct—no "as a moderator" preamble.
IMPORTANT: Stay completely neutral and factual. Do NOT promote, hype, or express enthusiasm about any technology. Do NOT use phrases like "it's very easy", "it's the future", "it's amazing", "next generation", etc. Just explain what it is plainly.
Do NOT re-ask or rephrase the discussion question. Do NOT ask the participant anything. Just answer and stop.
Return ONLY valid JSON array of exactly 1 string. No markdown, no extra text.
Text should be very natural and conversational and very human-like. Do NOT use any separators like ---, --, -, ;, :, or similar or any markdown or formatting.`;

  const user = `Discussion question: "${String(roundQuestion ?? "").slice(0, 300)}"\nParticipant's question: "${String(questionText).trim().slice(0, 300)}"`;
  try {
    const completion = await loggedOpenAI("moderator_answer", {
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 160,
      temperature: 0.7,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 1 && parsed[0]) {
      return [String(parsed[0]).trim()];
    }
  } catch (e) {
    console.error("generateModeratorQuestionAnswer error", e?.message || e);
  }
  return fallback;
}

// Canonical passkey explanation (1 bubble). Fixed — NOT LLM-generated — so every
// participant who asks "what is a passkey?" gets the exact same neutral definition
// (controlled study stimulus). Emitted at the normal human pace like other answers.
const PASSKEY_EXPLANATION = [
  "Good question! A passkey is a passwordless way to log into websites and apps. Instead of a password, you sign in with the fingerprint, face scan, or PIN you already use to unlock your device.",
];

// Mina's canned reaction after Eunice's fixed passkey explanation (item 23),
// written in her persona style. In poll rounds runPollRound emits it in the
// background (so the poll summary can be written concurrently and only its SEND
// waits for it); outside polls checkAndAnswerBotQuestion emits it inline.
const MINA_PASSKEY_FOLLOWUP = "oh i dont think i have used it before";

/**
 * Copy of the fixed passkey explanation addressed to whoever asked, so it's
 * clear who Eunice is answering when other messages landed in between:
 * "Good question @Mina! …" / "Good question @Mina @Test! …" (prof feedback).
 * The mentions decorate the EMITTED text only — everything that matches or
 * stores the explanation (alreadyExplained, isPasskeyAnswer, answeredQuestions,
 * the canned-follow-up trigger) keeps using the canonical PASSKEY_EXPLANATION[0].
 * NOTE: relies on the canonical text starting with "Good question!" — if that
 * wording changes, update the replace target here too.
 */
function personalizedPasskeyExplanation(askers) {
  const mentions = (askers || []).filter(Boolean).map((n) => `@${n}`).join(" ");
  if (!mentions) return PASSKEY_EXPLANATION[0];
  return PASSKEY_EXPLANATION[0].replace("Good question!", `Good question ${mentions}!`);
}

/**
 * Answer a participant's question to the moderator. If they're asking what a
 * passkey is (only checked on passkey rounds), return the fixed canonical
 * explanation; otherwise fall back to the LLM. Returns the bubbles array.
 */
async function answerParticipantQuestion(questionText, roundQuestion, alreadyAnswered = []) {
  const roundIsPasskey = String(roundQuestion ?? "").toLowerCase().includes("passkey");
  if (roundIsPasskey && (await isAskingWhatPasskeyIs(questionText, roundQuestion))) {
    // If the fixed explanation was already emitted this session, fall through
    // to the LLM so the second asker gets a brief "already covered" reminder
    // instead of a full re-explanation.
    const alreadyExplained = alreadyAnswered.some(
      (a) => a && a.answer === PASSKEY_EXPLANATION[0]
    );
    if (!alreadyExplained) return PASSKEY_EXPLANATION;
  }
  return generateModeratorQuestionAnswer(questionText, roundQuestion, alreadyAnswered);
}

/**
 * Generate a nudge message for an idle human participant.
 * nudgeNumber: 1 = gentle reminder to answer, 2 = "are you still there?" style.
 * context: { phase, question, transcript } — what the user is supposed to be doing right now.
 */
async function generateNudgeMessage(humanName, nudgeNumber, context = {}) {
  const { phase = "question", question = "", transcript = "" } = context;

  let phaseDesc, style;
  if (phase === "intro") {
    phaseDesc = "We are in the INTRODUCTION phase. The participant has NOT introduced themselves yet. You MUST ask them to introduce themselves. Do NOT ask what they think. Do NOT reference any question or discussion topic.";
    style = nudgeNumber === 1
      ? `Gently ask @${humanName} to introduce themselves. Example: "Hey @${humanName}, would you like to introduce yourself?"`
      : `Check if @${humanName} is still around and ask them to introduce themselves. Example: "Hey @${humanName}, still with us? We'd love to hear a quick intro from you."`;
  } else if (phase === "poll") {
    phaseDesc = `The moderator asked a quick poll question: "${question}". The participant needs to give a short answer.`;
    style = nudgeNumber === 1
      ? `Gently ask @${humanName} to share their thoughts on the question. Do NOT ask if they are still there. Example: "Hey @${humanName}, would love to hear your thoughts on this one whenever you're ready."`
      : `Check if @${humanName} is still around and ask them to share their thoughts. Example: "Hey @${humanName}, still around? Your thoughts on this would be great."`;
  } else {
    phaseDesc = `The current discussion question is: "${question}". The participant needs to share their thoughts.`;
    style = nudgeNumber === 1
      ? `Gently ask @${humanName} to share their thoughts on the question. Do NOT ask if they are still there. Example: "Hey @${humanName}, would love to hear your thoughts on this one whenever you're ready."`
      : `Check if @${humanName} is still around and ask them to share their thoughts. Example: "Hey @${humanName}, still around? Your thoughts on this would be great."`;
  }

  const sys = `You are a warm, casual human discussion moderator named ${MODERATOR_NAME}. Generate a single nudge message for an idle participant.

Phase: ${phase.toUpperCase()}
${phaseDesc}
${transcript ? `\nRecent chat:\n${transcript}` : ""}

Rules:
- MUST include @${humanName} somewhere in the message.
- Your nudge MUST match the current phase. ${phase === "intro" ? 'Since we are in the INTRODUCTION phase, you MUST ask them to introduce themselves. NEVER say "what you think about this" or reference any discussion topic.' : ""}
- Exactly 1 sentence. Never more than 2 sentences.
- Sound like a real person, NOT an AI assistant. No exclamation-heavy or overly enthusiastic language.
- Be concise and natural.
- ${style}
Return ONLY the message text. No quotes, no JSON, no formatting.`;

  try {
    const completion = await loggedOpenAI(`nudge:${phase}:${nudgeNumber}`, {
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: "Generate the nudge message." },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const text = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
    if (text && text.includes(`@${humanName}`)) return text;
  } catch (e) {
    console.error("generateNudgeMessage error", e?.message || e);
  }
  // Fallbacks
  if (phase === "intro") {
    return nudgeNumber === 1
      ? `Hey @${humanName}, would you like to introduce yourself?`
      : `Hey @${humanName}, still with us? We'd love to hear a quick intro from you.`;
  }
  return nudgeNumber === 1
    ? `Hey @${humanName}, would love to hear your thoughts on this one whenever you're ready.`
    : `Hey @${humanName}, still around? Your thoughts on this would be great.`;
}

/** Generate moderator cue: short ack of latest message + cue next person (OpenAI). */
async function generateModeratorCue(latestMessage, nextName, opts = {}) {
  const { isFirstInRound = false, isIntro = false, bigQuestion, roundQuestion } = opts;
  const latestStr = latestMessage
    ? `${latestMessage.name} said: "${String(latestMessage.text || "").slice(0, 200)}"`
    : "(no prior message)";

  const roundIsAboutPasskey = [roundQuestion, bigQuestion].some(
    (q) => q && String(q).toLowerCase().includes("passkey")
  );
  const participantAskedWhatPasskeyIs =
    roundIsAboutPasskey && latestMessage && (await isAskingWhatPasskeyIs(latestMessage.text, roundQuestion ?? bigQuestion));

  const sys = `You are a real human discussion moderator in a casual group chat. Generate ONE short message (1-2 sentences max).

Your message MUST have these two parts in order:
1. A SHORT PERSONAL REACTION (3-4 words) that references the SPECIFIC content of what the person just said. Not a generic "makes sense" or "gotcha" — your reaction must show you actually heard the specific thing they said. E.g. if they mentioned "kids", react to the kids part; if they mentioned "work VPN", react to the work VPN part.
2. Then CLEARLY hand the turn to the next person: END the reaction with a punctuation mark (a period, "!", or ".."), THEN @name followed by a SHORT prompt phrase (2-4 words) so it is obviously a hand-off and not a comment about them.

CRITICAL RULES:
- The reaction MUST be specific to what they said. Do NOT use generic acks like "Makes sense", "Gotcha", "Got it", "Interesting" by themselves — they're too vague. Add 2-3 words that point at the actual content.
- Keep the reaction SHORT — 3-4 words, not a full sentence. The goal is "I heard you specifically", not "let me summarize".
- ALWAYS separate the reaction from the hand-off with punctuation (a period, "!", or ".."). The reaction and the @name must NEVER run together into one phrase — e.g. "Love new technology excitement @Sid" is WRONG because it reads like you are describing @Sid. Correct: "Love the excitement! @Sid, what about you?"
- ALWAYS put a SHORT prompt phrase after the @name so it clearly hands over the turn (2-4 words), e.g. "what about you?", "your take?", "how about you?", "your turn?". NEVER end with just "@name" or "@name?" alone.
- Do NOT explain, define, or add information about any technology (passkeys, VPNs, password managers, etc.).
- Do NOT add your own opinion or commentary (no "that's smart", "great approach", "it's safer", etc.). Stay neutral — react to WHAT they said, not whether it's good.
- Make it human and casual. No separators like "---", "—", "-", ";", or ":" in your message. No markdown formatting. No quotes. No JSON. No extra text.
- Don't say "noted"
- Never use the word "huh"

Sound like a real person texting, not a formal moderator.

IMPORTANT: When mentioning any participant by name, ALWAYS prefix their name with @ (e.g. @Anthony, @Mina). Every single name mention must have the @ prefix.

Good examples (specific reaction → @next):
- "Yeah I hear you. @${nextName}, you?"
- "Mm, the kids thing. @${nextName}, how about you?"
- "Right, it is exciting to try out new stuff. @${nextName}, same question for you"
- "Switched for the speed. @${nextName}, your take?"
- "Fair. It is good to stick to what works. @${nextName}, what about you?"
- "Ohh I totally understand why. @${nextName}, your turn"

BAD examples (too generic OR adds info/opinion — avoid these):
- "Makes sense. @${nextName}, how about you?" (generic — no specific reaction)
- "Fast adoption, noted. @${nextName}, how about you?" (too robotic — "noted" is not human)
- "Gotcha. @${nextName}, your turn?" (generic — no specific reaction)
- "Interesting. @${nextName}?" (generic — no specific reaction, and no prompt phrase after the @name)
- "Love new technology excitement @${nextName}" (WRONG — no punctuation before the @name and no prompt phrase, so it reads like you are describing them instead of calling on them)
- "Thanks for sharing, @[Name]. @[Name], what do you think?" (too formal)
- "A passkey is a way to sign in using biometrics. @[Name]?" (DO NOT explain things)
- "That makes logging in so much easier! @[Name]?" (DO NOT add opinions)

Output ONLY the message text — no JSON, no quotes, no formatting, no separators like ---.
When in the middle of a round, do NOT ask a new question — only react and cue the next person for the same question.`;

  let userPrompt;
  if (participantAskedWhatPasskeyIs) {
    userPrompt = `A participant indicated they don't know what passkey is. Just briefly acknowledge their response (e.g. "No worries" or "Fair enough") and cue the next person: @${nextName}. Do NOT explain what a passkey is here. Keep it short. Remember to prefix the name with @.`;
  } else if (isIntro) {
    userPrompt = `The latest message: ${latestStr}. Next person to cue: @${nextName}. Write a brief ack and then ask @${nextName} to introduce themselves. Remember to prefix the name with @.`;
  } else if (isFirstInRound && bigQuestion) {
    userPrompt = `We're starting a new question: "${String(bigQuestion).slice(0, 300)}". No one has answered this question yet. Cue @${nextName} to answer first (brief transition only, e.g. "@[Name], what do you think?"). Do NOT thank or acknowledge anyone as having just responded—no one has responded to this question yet. Remember to prefix the name with @.`;
  } else if (roundQuestion) {
    userPrompt = `The current question for this round is: "${String(roundQuestion).slice(0, 300)}".

Latest message to react to: ${latestStr}

Next person to cue: @${nextName}

Your reaction MUST quote, paraphrase, or name a SPECIFIC thing from their message in 3-4 words — not a generic "got it", "makes sense", "interesting", or "gotcha". If they said they're cautious, react to "cautious". If they mentioned VPN at work, react to "VPN at work". If they said they don't know, react to "never heard of it" or similar. Then cue @${nextName}.

Do NOT introduce a new or different question. Remember to prefix the name with @.`;
  } else {
    userPrompt = `Latest message to react to: ${latestStr}

Next person to cue: @${nextName}

Your reaction MUST quote, paraphrase, or name a SPECIFIC thing from their message in 3-4 words — not a generic "got it", "makes sense", "interesting", or "gotcha". Then cue @${nextName}.

Remember to prefix the name with @.`;
  }

  // Tag which branch this cue came from so the log shows whether the strengthened
  // mid-round prompt is actually being used vs. one of the other paths.
  const cueBranch = participantAskedWhatPasskeyIs
    ? "asked_what_passkey"
    : isIntro
      ? "intro"
      : isFirstInRound && bigQuestion
        ? "first_in_round"
        : roundQuestion
          ? "mid_round"
          : "default";

  try {
    const completion = await loggedOpenAI(`moderator_cue:${cueBranch}:${nextName}`, {
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });
    const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
    if (text) return text.replace(/---/g, "").trim() || `How about you, @${nextName}?`;
  } catch (e) {
    console.error("generateModeratorCue error", e?.message || e);
  }
  return `How about you, @${nextName}?`;
}

/** Last non-moderator message from session (for ack context). */
function getLastParticipantMessage(session) {
  if (!session?.messages?.length) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m?.name && m.name !== MODERATOR_NAME) return m;
  }
  return null;
}

/** Index in session.messages where the current round's answers start (after moderator asked the question). */
function getRoundStartIndex(session, questionPrefix) {
  if (!session?.messages?.length) return 0;
  const prefix = String(questionPrefix ?? "").slice(0, 80);
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    if (m?.name === MODERATOR_NAME && String(m?.text || "").includes(prefix)) return i + 1;
  }
  return 0;
}

/** True if the given name is the human participant (case-insensitive). */
function isHumanTurn(session, name) {
  return !!(session?.participantName && name && String(name).toLowerCase() === session.participantName.toLowerCase());
}

/** Reset call-on state for a new question. */
function resetCallOnState(co, question) {
  co.question = question;
  co.whoSpoke = [];
  co.currentIndex = 0;
  co.waitingForHumanIdle = false;
  co.humanRepliedThisTurn = false;
  co.roundDone = false;
  co.disagreementPhase = false;
  co.disagreementQueue = [];
  co.disagreementIndex = 0;
}

// Fixed call-on orders for the first and last big questions (Item 11); any other
// big question keeps the rotate-by-one behavior. CALL_ON_USER_TOKEN = the human
// participant; the rest are bot handles (every study group uses Sid / Mina /
// Anthony). buildCallOnOrder maps the token to the participant and filters to
// whoever is actually present, appending anyone not named so no one is dropped.
const CALL_ON_USER_TOKEN = "@user";
const FIRST_BIG_Q_ORDER = ["Anthony", "Mina", CALL_ON_USER_TOKEN, "Sid"];
const LAST_BIG_Q_ORDER = ["Sid", "Anthony", "Mina", CALL_ON_USER_TOKEN];
// Item 12: this bot is never asked the disagreement follow-up in the last big question.
const LAST_Q_DISAGREEMENT_EXCLUDE = "Mina";

function buildCallOnOrder(session, template) {
  const present = [...(session.bots || []), session.participantName];
  const mapped = template.map((n) => (n === CALL_ON_USER_TOKEN ? session.participantName : n));
  const ordered = mapped.filter((n) => present.includes(n));
  for (const n of present) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

function lastBigQuestionIndex(session) {
  const rounds = session?.allRounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i]?.type === "big_question") return i;
  return -1;
}

/** True if the human has sent any message after Eunice's last "To start us off" intro prompt. */
function hasHumanRepliedAfterIntroPrompt(session) {
  if (!session?.messages?.length || !session.participantName) return false;
  const humanName = session.humanDisplayName;
  let lastIntroPromptIndex = -1;
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    if (m?.name === MODERATOR_NAME && String(m?.text || "").includes("To start us off")) {
      lastIntroPromptIndex = i;
    }
  }
  if (lastIntroPromptIndex < 0) return false;
  for (let i = lastIntroPromptIndex + 1; i < session.messages.length; i++) {
    if (session.messages[i]?.name === humanName) return true;
  }
  return false;
}

// =====================
// Session state (one per socket/room)
// =====================
// Group rotation: pro → anti → half → pro → ...
const GROUP_ROTATION = ["pro", "anti", "control"];
const GROUP_BOTS = {
  pro:     ["sid_pro", "mina_pro", "anthony_pro"],
  anti:    ["sid_anti", "mina_anti", "anthony_anti"],
  control: ["sid_control", "mina_control", "anthony_control"],
};
let groupRotationIndex = 0;

function createSession(participantName) {
  let assignedGroup = null;
  let cast;
  if (CLI_BOT_NAMES.length > 0) {
    cast = getCastByHandles(CLI_BOT_NAMES);
  } else {
    assignedGroup = GROUP_ROTATION[groupRotationIndex % GROUP_ROTATION.length];
    groupRotationIndex++;
    cast = getCastByHandles(GROUP_BOTS[assignedGroup]);
    logLine("GROUP", `assigned group: ${assignedGroup} → bots: ${GROUP_BOTS[assignedGroup].join(", ")}`);
  }
  const botIds = cast.map((p) => p.id);
  const bots = cast.map((p) => p.handle);
  const botIdMap = {};
  cast.forEach((p) => { botIdMap[p.handle] = p.id; });
  if (CLI_BOT_NAMES.length > 0 && bots.length === 0) {
    console.warn("CLI bot names matched no personas; falling back to random cast.");
    assignedGroup = GROUP_ROTATION[groupRotationIndex % GROUP_ROTATION.length];
    groupRotationIndex++;
    cast = getCastByHandles(GROUP_BOTS[assignedGroup]);
    cast.forEach((p) => bots.push(p.handle));
    logLine("GROUP", `fallback assigned group: ${assignedGroup} → bots: ${bots.join(", ")}`);
  } else if (CLI_BOT_NAMES.length > 0 && bots.length < CLI_BOT_NAMES.length) {
    console.warn(`Only ${bots.length} of ${CLI_BOT_NAMES.length} CLI names matched: ${bots.join(", ")}`);
  }
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const order = [...bots, participantName];
  const script = getModeratorScript(assignedGroup);
  const allRounds = script
    .filter((s) => s.type === "big_question" || s.type === "poll")
    .map((s) => ({ type: s.type, question: s.messages[0] }));

  return {
    sessionId,
    assignedGroup,
    moderatorName: MODERATOR_NAME,
    botIds,
    botIdMap,
    bots,
    participantName,
    humanDisplayName: capitalizeFirst(participantName),
    messages: [],
    waitingForHumanIntro: false,
    humanGaveIntro: false,
    callOnState: {
      question: allRounds[0]?.question || "",
      order,
      whoSpoke: [],
      currentIndex: 0,
      waitingForHumanIdle: false,
      humanRepliedThisTurn: false,
      roundDone: false,
      disagreementPhase: false,
      disagreementQueue: [],
      disagreementIndex: 0,
    },
    allRounds,
    answeredQuestions: [], // { question, answer } pairs the moderator has already answered
    currentRoundIndex: -1,
    currentRoundType: allRounds[0]?.type || "big_question",
    pollState: null,
    usedRoundAckIndices: [],
    roundTranscript: [],  // Messages for current round; reset each new question
    humanResponsesByRound: {},  // { roundIndex: ["msg1", "msg2", ...] }
  };
}

// Item 7: strip the filler word "huh" from bot/moderator text (LLM sometimes adds
// it, e.g. "Clutter and broken workflows, huh @Mina"). Removes the token plus an
// adjacent comma and tidies spacing/punctuation. Applied to generated messages only,
// never the human participant's own text.
function stripHuh(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*,?\s*\bhuh\b\s*,?/gi, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function addMessage(session, name, text) {
  let clean = String(text).trim();
  // Don't touch the human participant's own words — only bot/moderator messages.
  if (name !== session.humanDisplayName && name !== session.participantName) {
    clean = stripHuh(clean);
  }
  const m = { name, text: clean, ts: Date.now() };
  session.messages.push(m);
  if (session.roundTranscript) session.roundTranscript.push({ name, text: m.text });
  appendTranscriptLine(session, name, m.text);
  return m;
}

// =====================
// Round-complete acknowledgment (one random per round, no repeat in session)
// =====================
const ROUND_ACK_TEXTS = [
  "Ok! Thanks everyone for sharing!",
  "Thanks for sharing, everyone!",
  "Really appreciate everyone's input.",
  "Thanks everyone! great to hear from all of you.",
  "Thanks you all for those answers!",
  "Got it, thanks for sharing!",
  "Appreciate y'all sharing your thoughts.",
  "Thanks for sharing your views :)",
  "Thanks everyone! It is helpful to hear from each of you.",
  "Got it, thanks everyone for sharing!"
];

/** Pick a random round-ack text not yet used this session; mark it used. Returns text. */
function pickRoundAckText(session) {
  const used = session.usedRoundAckIndices ?? [];
  const available = ROUND_ACK_TEXTS.map((_, i) => i).filter((i) => !used.includes(i));
  const idx = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : Math.floor(Math.random() * ROUND_ACK_TEXTS.length);
  session.usedRoundAckIndices = [...used, idx];
  return ROUND_ACK_TEXTS[idx];
}

// =====================
// Poll lead-in transitions — prepended (same bubble) to the poll question for
// polls 2 & 3. Poll 1 still uses the standalone "quick poll" preamble.
// MIDDLE pool = polls that aren't the last poll; LAST pool = the final poll of
// the sequence. Each pool picks with no-repeat-in-session.
// =====================
const POLL_LEAD_INS_MIDDLE = [
  "Moving on,",
  "Alright, next one,",
  "Ok, next up,",
  "Great, next question,",
  "Onto the next,",
];

const POLL_LEAD_INS_LAST = [
  "Lastly,",
  "One more,",
  "Last one,",
];

/** Pick a random lead-in not yet used this session from the given pool. */
function pickFromPool(session, pool, key) {
  const used = session[key] ?? [];
  const available = pool.map((_, i) => i).filter((i) => !used.includes(i));
  const idx = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : Math.floor(Math.random() * pool.length);
  session[key] = [...used, idx];
  return pool[idx];
}

/** Prepend a lead-in to a poll question. Lowercases the first char of the
 *  question so "Have you ever…" becomes "…, have you ever…" while acronyms
 *  like VPN stay intact. */
function withPollLeadIn(leadIn, question) {
  const rest = question.length > 0
    ? question.charAt(0).toLowerCase() + question.slice(1)
    : question;
  return `${leadIn} ${rest}`;
}

// =====================
// Bot intro messages (one chosen at random per bot)
// =====================
const BOT_INTROS = {
  Mina: [
    "Hi, I'm Mina. I work in retail in LA. Nice to meet you all",
    "Hiii my name is Mina! I work in retail in LA",
    "Hi yall! I'm Mina. First time doing this kind of thing!",
  ],
  Anthony: [
    "Hi, I'm Anthony. I teach high school math in Arlington.",
    "Hey, I'm Anthony. I'm a math teacher. Nice to meet everyone.",
    "I am Anthony. I teach math in Virginia.",
  ],
  Vivian: [
    "Hi I'm Vivian. I'm a psych undergrad at Emory.",
    "Hey my name is Vivian. I live in Atlanta",
    "Hello everyone! I'm Vivian. I'm a student at Emory studying psychology",
  ],
  Anika: [
    "Hi I'm Anika. I'm a massage therapist in California. Nice to meet you all",
    "Hey my name is Anika. I work as a massage therapist in California.",
    "I am Anika.",
  ],
  Sid: [
    "Hello I'm Sid. I am in IT support. Nice to meet you all",
    "Hey, I'm Sid. I am an IT support technician in New Jersey.",
    "Sid. I am an IT support technician in New Jersey.",
  ],
};

// =====================
// App & Socket
// =====================
// CORS: withCredentials requires explicit origins (no "*")
const CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://focusgroup.cc.gatech.edu",
  "https://www.focusgroup.cc.gatech.edu",
];
const app = express();
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));
// Serve profile pictures so client can load participant avatars (profile_1.jpg … profile_9.jpg)
const profilePicturesDir = path.join(__dirname, "..", "profile_pictures");
app.use("/profile_pictures", express.static(profilePicturesDir));
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/auth_choice", express.json(), async (req, res) => {
  const { sessionId, participantId, choice, hesitationMs } = req.body || {};
  if (!sessionId || !participantId || !["password", "passkey"].includes(choice)) {
    return res.status(400).json({ error: "Invalid request" });
  }
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  try {
    await dbPool.execute(
      `UPDATE participant_responses SET auth_choice = ? WHERE session_id = ? AND participant_id = ?`,
      [choice, sessionId, participantId]
    );
    logLine("DB", `REST auth_choice=${choice} hesitation=${hesitationMs}ms for ${participantId}`);
    res.json({ ok: true });
  } catch (e) {
    logLine("DB_ERROR", `REST auth_choice failed: ${e?.message}`);
    res.status(500).json({ error: "Database error" });
  }
});

// =====================
// Focus-group registration endpoints
// =====================
const WEBAUTHN_RP_NAME = "Georgia Tech Focus Group";
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || `http://localhost:${process.env.PORT || 3001}`;

// Sanitize a client-supplied duration into a non-negative integer ms value,
// or null if unusable. Capped to MySQL INT max so a garbage value can't error the write.
function sanitizeDurationMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 2147483647);
}

// Sanitize the client-supplied click log into a JSON string of valid method names,
// or null if there's nothing usable. Capped to avoid unbounded payloads.
function sanitizeAuthMethodClicks(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .filter((m) => m === "password" || m === "passkey")
    .slice(0, 100);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

// POST /api/focus-group/log-auth-click
// Persists the running click log on EVERY SecureStep card click, so the data
// survives even if the participant never completes registration (abandons the
// page, cancels the passkey prompt, etc.). Sole writer of auth_method_clicks.
app.post("/api/focus-group/log-auth-click", express.json(), async (req, res) => {
  const { sessionId, participantId, authMethodClicks, msFromShownToLastClick } = req.body || {};
  if (!sessionId || !participantId) return res.status(400).json({ error: "Session context missing" });
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  const clicks = sanitizeAuthMethodClicks(authMethodClicks);
  if (!clicks) return res.json({ ok: true }); // nothing valid to store
  // Selection duration: cards shown → LAST method click. Every click overwrites
  // (latest wins, unlike the first-wins timestamps elsewhere); a missing/invalid
  // value never clobbers a stored one. The registration endpoints write the final
  // authoritative value on success.
  const selectionMs = sanitizeDurationMs(msFromShownToLastClick);
  try {
    await dbPool.execute(
      `UPDATE participant_responses
       SET auth_method_clicks = ?, dur_auth_selection_ms = COALESCE(?, dur_auth_selection_ms)
       WHERE session_id = ? AND participant_id = ?`,
      [clicks, selectionMs, sessionId, participantId]
    );
    res.json({ ok: true });
  } catch (e) {
    logLine("DB_ERROR", `log-auth-click failed: ${e?.message}`);
    res.status(500).json({ error: "Failed to log click" });
  }
});

// POST /api/focus-group/assign-auth-order
// Alternates the SecureStep card order strictly: even-indexed assigned participants
// see password on top, odd-indexed see passkey on top. Idempotent per participant —
// once a row has auth_method_top set, this returns the same value.
app.post("/api/focus-group/assign-auth-order", express.json(), async (req, res) => {
  const { sessionId, participantId } = req.body || {};
  if (!sessionId || !participantId) return res.status(400).json({ error: "Session context missing" });
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  try {
    const [existing] = await dbPool.execute(
      `SELECT auth_method_top FROM participant_responses WHERE session_id = ? AND participant_id = ?`,
      [sessionId, participantId]
    );
    if (!existing.length) return res.status(404).json({ error: "Participant row not found" });
    if (existing[0].auth_method_top === "password" || existing[0].auth_method_top === "passkey") {
      return res.json({ authMethodTop: existing[0].auth_method_top });
    }
    const [countRows] = await dbPool.execute(
      `SELECT COUNT(*) AS n FROM participant_responses WHERE auth_method_top IS NOT NULL`
    );
    const n = Number(countRows[0]?.n || 0);
    const assignment = n % 2 === 0 ? "password" : "passkey";
    await dbPool.execute(
      `UPDATE participant_responses SET auth_method_top = ? WHERE session_id = ? AND participant_id = ?`,
      [assignment, sessionId, participantId]
    );
    logLine("DB", `auth_method_top assigned: ${assignment} (alternation index=${n}) participant=${participantId}`);
    res.json({ authMethodTop: assignment });
  } catch (e) {
    logLine("DB_ERROR", `assign-auth-order failed: ${e?.message}`);
    res.status(500).json({ error: "Failed to assign auth order" });
  }
});

// POST /api/focus-group/register-password
app.post("/api/focus-group/register-password", express.json(), async (req, res) => {
  const { email, password, sessionId, participantId, authSelectionMs, authCreationMs } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (!sessionId || !participantId) return res.status(400).json({ error: "Session context missing" });
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  try {
    const hash = await bcrypt.hash(password, 12);
    const strength = zxcvbn(password).score; // 0–4 (zxcvbn standard)
    const token = crypto.randomUUID();
    // Final durations, measured client-side and anchored on the LAST method click:
    // selection = cards shown → last click; creation = last click → this success.
    const selectionMs = sanitizeDurationMs(authSelectionMs);
    const creationMs = sanitizeDurationMs(authCreationMs);
    await dbPool.execute(
      `UPDATE participant_responses
       SET email = ?, password_hash = ?, password_strength = ?, session_token = ?, auth_choice = 'password',
           dur_auth_selection_ms = COALESCE(?, dur_auth_selection_ms),
           dur_auth_creation_ms = COALESCE(?, dur_auth_creation_ms)
       WHERE session_id = ? AND participant_id = ?`,
      [email, hash, strength, token, selectionMs, creationMs, sessionId, participantId]
    );
    logLine("DB", `User registered (password, strength=${strength}) email=${email} participant=${participantId}`);
    res.json({ ok: true, sessionToken: token });
  } catch (e) {
    logLine("DB_ERROR", `register-password failed: ${e?.message}`);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/focus-group/webauthn-register-options
app.post("/api/focus-group/webauthn-register-options", express.json(), async (req, res) => {
  const { email, sessionId, participantId } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email is required" });
  if (!sessionId || !participantId) return res.status(400).json({ error: "Session context missing" });
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  try {
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userName: email,
      userDisplayName: email,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    // Persist challenge so we can verify later
    const [result] = await dbPool.execute(
      `UPDATE participant_responses
       SET email = ?, webauthn_challenge = ?
       WHERE session_id = ? AND participant_id = ?`,
      [email, options.challenge, sessionId, participantId]
    );
    logLine("DB", `WebAuthn options generated for email=${email} participant=${participantId} rows=${result.affectedRows}`);
    res.json({ ok: true, options });
  } catch (e) {
    logLine("DB_ERROR", `webauthn-register-options failed: ${e?.message}`);
    res.status(500).json({ error: "Failed to generate registration options" });
  }
});

// POST /api/focus-group/webauthn-register-verify
app.post("/api/focus-group/webauthn-register-verify", express.json(), async (req, res) => {
  const { email, attestation, sessionId, participantId, authSelectionMs, authCreationMs } = req.body || {};
  if (!email || !attestation) return res.status(400).json({ error: "Email and attestation are required" });
  if (!sessionId || !participantId) return res.status(400).json({ error: "Session context missing" });
  if (!dbPool) return res.status(503).json({ error: "Database not available" });
  try {
    // Retrieve stored challenge
    const [rows] = await dbPool.execute(
      `SELECT webauthn_challenge FROM participant_responses WHERE session_id = ? AND participant_id = ?`,
      [sessionId, participantId]
    );
    if (!rows.length || !rows[0].webauthn_challenge) {
      return res.status(400).json({ error: "No pending registration for this session" });
    }
    const expectedChallenge = rows[0].webauthn_challenge;
    const verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
    });
    if (!verification.verified) {
      return res.status(400).json({ error: "Passkey verification failed" });
    }
    const token = crypto.randomUUID();
    // Final durations, measured client-side and anchored on the LAST method click:
    // selection = cards shown → last click; creation = last click → this success.
    const selectionMs = sanitizeDurationMs(authSelectionMs);
    const creationMs = sanitizeDurationMs(authCreationMs);
    await dbPool.execute(
      `UPDATE participant_responses
       SET webauthn_credential = ?, webauthn_challenge = NULL, session_token = ?, auth_choice = 'passkey',
           dur_auth_selection_ms = COALESCE(?, dur_auth_selection_ms),
           dur_auth_creation_ms = COALESCE(?, dur_auth_creation_ms)
       WHERE session_id = ? AND participant_id = ?`,
      [JSON.stringify(verification.registrationInfo), token, selectionMs, creationMs, sessionId, participantId]
    );
    logLine("DB", `User registered (passkey) email=${email} participant=${participantId}`);
    res.json({ ok: true, sessionToken: token });
  } catch (e) {
    logLine("DB_ERROR", `webauthn-register-verify failed: ${e?.message}\n${e?.stack}`);
    res.status(500).json({ error: e?.message || "Verification failed" });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Tell nginx / Plesk's reverse proxy not to buffer socket.io polling responses.
// Without this, long-poll responses (server → client) get held until the proxy's
// buffer fills, so each emit lands at the client batched with whatever the
// server writes next — often making the participant's own echo appear bundled
// with the next bot message. The header is honored by nginx (X-Accel-Buffering)
// and is a no-op anywhere else, so it's safe to set unconditionally.
io.engine.on("headers", (headers) => {
  headers["X-Accel-Buffering"] = "no";
});
io.engine.on("initial_headers", (headers) => {
  headers["X-Accel-Buffering"] = "no";
});

const PORT = process.env.PORT || 3001;

// =====================
// Socket: per-connection state and helpers
// =====================
// Session store: keeps sessions alive across reconnects
const activeSessions = new Map(); // sessionId → session object
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min timeout for abandoned sessions

io.on("connection", (socket) => {
  let session = null;
  const botTypingTimeoutRef = { current: null };

  function emitTyping(who, isTyping) {
    if (!session) return;
    const label = session.bots?.includes(who) ? `bot=${who}` : who === MODERATOR_NAME ? "moderator" : "human";
    logLine("TYPING", `${label} ${isTyping}`);
    io.to(socket.id).emit("typing", { who, isTyping });
  }

  function emitMessage(name, text) {
    if (!session) return;
    const m = addMessage(session, name, text);
    logLine("MESSAGE", `[${name}] "${clip(m.text, 160)}"`);
    io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
  }

  function startHumanTurnForCallOn(name) {
    const co = session?.callOnState;
    if (!co) return;
    const nameForLog = name === session.participantName ? session.humanDisplayName : name;
    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=human ${nameForLog}, waiting for human_idle`);
    co.waitingForHumanIdle = true;
    co.humanRepliedThisTurn = false;
    session.humanGaveSubstantiveResponseThisTurn = false;
    session.humanMessagesThisRound = [];
    session.humanMessagesBurst = [];
    session.lastPromptForHuman = { type: "call_on", prompt: co.question };
    startIdleNudgeTimer();
  }

  /** True if we are waiting for the human to respond (intro, call-on, or disagreement). */
  function isWaitingForHuman(session) {
    if (!session) return false;
    return !!(
      session.waitingForHumanIntro ||
      (session.callOnState?.waitingForHumanIdle) ||
      session.waitingForHumanDisagreementResponse
    );
  }

  function clearIdleNudgeTimer() {
    if (session?.idleNudgeIntervalId) {
      clearInterval(session.idleNudgeIntervalId);
      session.idleNudgeIntervalId = null;
    }
    if (session) {
      session.idleStartedAt = null;
      session.idleLastActivityAt = null;
      session.idleUserHasTyped = false;
      session.idleHasDraft = false;
      session.idleLastNudgeAt = null;
      session.idleNudgeCount = 0;
    }
  }

  function startIdleNudgeTimer() {
    clearIdleNudgeTimer();
    if (!session) return;
    session.idleStartedAt = Date.now();
    session.idleLastActivityAt = Date.now();
    session.idleUserHasTyped = false;
    session.idleHasDraft = false;
    session.idleLastNudgeAt = null;
    session.idleNudgeCount = 0;

    session.idleNudgeIntervalId = setInterval(async () => {
      if (!session || !isWaitingForHuman(session)) {
        clearIdleNudgeTimer();
        return;
      }
      const now = Date.now();
      const nudgeInterval = session.idleHasDraft ? NUDGE_AFTER_TYPING_WITH_DRAFT_MS : NUDGE_MS;
      const nextNudgeAt = session.idleLastNudgeAt != null
        ? session.idleLastNudgeAt + nudgeInterval
        : session.idleUserHasTyped
          ? (session.idleLastActivityAt || session.idleStartedAt) + nudgeInterval
          : session.idleStartedAt + NUDGE_MS;

      if (now < nextNudgeAt) return;

      // Don't nudge while user is actively typing — reset the timer and wait
      if (session.humanIsTyping) {
        session.idleLastNudgeAt = null;
        session.idleLastActivityAt = Date.now();
        return;
      }

      session.idleLastNudgeAt = now;
      session.idleNudgeCount = (session.idleNudgeCount || 0) + 1;

      if (session.idleNudgeCount >= MAX_NUDGES) {
        clearIdleNudgeTimer();
        const kickMsg = `No worries @${session.humanDisplayName}, looks like you got pulled away. We'll wrap things up on your end so the group can keep going. Thanks for signing up!`;
        emitMessage(MODERATOR_NAME, kickMsg);
        logLine("QUEUE", "idle kick: closing session after unanswered nudges");
        session.chatEndAt = session.chatEndAt || new Date();
        await new Promise((r) => setTimeout(r, KICK_DISPLAY_MS));
        io.to(socket.id).emit("kicked", { reason: "idle", message: "You have been removed from the session." });
        saveCurrentRoundResponses();
        await saveSessionToDatabase(session);
        activeSessions.delete(session.sessionId);
        session = null;
        return;
      }

      // Build context for the nudge based on current phase
      const nudgeContext = {};
      if (session.waitingForHumanIntro) {
        nudgeContext.phase = "intro";
      } else if (session.currentRoundType === "poll") {
        nudgeContext.phase = "poll";
        nudgeContext.question = session.callOnState?.question || "";
      } else {
        nudgeContext.phase = "question";
        nudgeContext.question = session.callOnState?.question || "";
      }
      // Include recent transcript for context
      const recentMsgs = (session.roundTranscript || session.messages || []).slice(-8);
      nudgeContext.transcript = recentMsgs.map((m) => `${m.name}: ${m.text}`).join("\n").slice(0, 600);
      const nudgeMsg = await generateNudgeMessage(session.humanDisplayName, session.idleNudgeCount, nudgeContext);
      // Cancel if user is typing OR if the wait state changed (user already responded and advanced) mid-await.
      const cancelCheck = () => !session || !!session.humanIsTyping || !isWaitingForHuman(session);
      await emitModeratorLine(nudgeMsg, { cancelCheck, humanPace: true });
      if (!session || cancelCheck()) {
        if (session) {
          session.idleNudgeCount = Math.max(0, (session.idleNudgeCount || 0) - 1);
          session.idleLastNudgeAt = null;
          session.idleLastActivityAt = Date.now();
        }
        logLine("QUEUE", "idle nudge cancelled (user responded or started typing)");
        return;
      }
      logLine("QUEUE", `idle nudge ${session.idleNudgeCount}/${MAX_NUDGES} sent`);
    }, IDLE_CHECK_MS);
  }

  /** Kick user for 4 unsubstantial messages in a row. Must be called inside human_message handler. */
  async function kickForUnsubstantial() {
    clearIdleNudgeTimer();
    clearElaborationPromptTimer();
    const kickMsg = "Please provide more substantial responses. You have been removed from the session.";
    emitMessage(MODERATOR_NAME, kickMsg);
    logLine("QUEUE", "unsubstantial kick: closing session after 4 unsubstantial in a row");
    session.chatEndAt = session.chatEndAt || new Date();
    await new Promise((r) => setTimeout(r, KICK_DISPLAY_MS));
    io.to(socket.id).emit("kicked", { reason: "unsubstantial", message: kickMsg });
    saveCurrentRoundResponses();
    await saveSessionToDatabase(session);
    activeSessions.delete(session.sessionId);
    session = null;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomBetween(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Length-based typing delay (min 800ms), used for bots and for the moderator's
   * human-paced messages (per-person reactions, round summaries, discussion
   * prompts, and the final big question). Moderator explanatory broadcasts do NOT
   * use this — they get a fixed delay (EXPLANATORY_TYPING_DELAY_MS) regardless of
   * length, handled in emitModeratorLine.
   */
  function typingDelayMs(text) {
    const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length || 1;
    const wps = TYPING_SPEED.min + Math.random() * (TYPING_SPEED.max - TYPING_SPEED.min);
    return Math.max(800, Math.round((words / wps) * 1000));
  }

  /** Emit a bot's message bubbles with typing indicators; uses timeoutRef so disconnect can clear pending delay. */
  async function emitBotBubblesWithTyping(botName, bubbles, timeoutRef) {
    if (!Array.isArray(bubbles)) return;
    for (let i = 0; i < bubbles.length; i++) {
      if (!session) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      // First bubble: short pause (already waited before API call); subsequent: short consecutive delay
      const waitMs = i === 0
        ? randomBetween(0, 2000)
        : randomBetween(MODERATOR_CONSECUTIVE_DELAY_MS.min, MODERATOR_CONSECUTIVE_DELAY_MS.max);
      logLine("WAIT", `${botName} start waiting for ${(waitMs / 1000).toFixed(1)}s`);
      await new Promise((r) => {
        timeoutRef.current = setTimeout(r, waitMs);
      });
      logLine("WAIT", `${botName} done waiting`);
      if (!session) return;
      emitTyping(botName, true);
      await delay(typingDelayMs(bubbles[i]));
      if (!session) return;
      emitTyping(botName, false);
      emitMessage(botName, bubbles[i]);
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  /** If advance was cancelled (user started typing), roll back and wait for human_idle again. opts: "prev" | "last" | { rollbackIndex, clearRound }. */
  function cancelAdvance(session, reason, opts = "prev") {
    const rollbackIndex = typeof opts === "string" ? opts : opts.rollbackIndex ?? "prev";
    const clearRound = typeof opts === "object" && opts.clearRound;
    const co = session?.callOnState;
    if (co) {
      if (rollbackIndex === "prev") co.currentIndex -= 1;
      else if (rollbackIndex === "last") co.currentIndex = co.order.length - 1;
      co.waitingForHumanIdle = true;
      co.humanRepliedThisTurn = true;
      if (clearRound || rollbackIndex === "last") {
        co.roundDone = false;
        co.disagreementPhase = false;
      }
    }
    if (session) {
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
    }
    logLine("QUEUE", reason);
    // human_idle handler cleared the nudge timer before calling advanceCallOn; now
    // that we're waiting for the user again, re-arm it so a draft-and-sit user still
    // gets escalated and the chat never sits silently with no path forward.
    if (session && isWaitingForHuman(session)) {
      startIdleNudgeTimer();
    }
  }

  function wasAdvanceCancelled(session) {
    return !!(session?.pendingAdvanceFromIdle && session?.cancelAdvanceFromIdle);
  }

  async function emitModeratorLine(text, opts = {}) {
    // humanPace: type this message at the length-based human speed (per-person
    // replies, summaries, discussion prompts, final big question). Without it, the
    // message is an explanatory broadcast and uses a fixed 4–6s delay (see below).
    // awaitBeforeSend: promise to await AFTER the type-out, right before the send —
    // the typing indicator stays on while waiting. Lets a flow "write up" a message
    // concurrently with something else and only serialize the final emit (poll
    // summary vs Mina's canned follow-up). Callers MUST pass a bounded promise
    // (Promise.race with a timeout) so a never-resolved promise can't hang here.
    const { cancelCheck, skipThinkDelay, consecutive, humanPace, awaitBeforeSend } = opts;
    if (!session) return;
    if (session.cancelAdvanceFromIdle || cancelCheck?.()) return;
    // Think delay (no typing indicator yet)
    if (!skipThinkDelay) {
      const range = consecutive ? MODERATOR_CONSECUTIVE_DELAY_MS : MODERATOR_THINK_DELAY_MS;
      const modWaitMs = randomBetween(range.min, range.max);
      logLine("WAIT", `${MODERATOR_NAME} start waiting for ${(modWaitMs / 1000).toFixed(1)}s`);
      await delay(modWaitMs);
      logLine("WAIT", `${MODERATOR_NAME} done waiting`);
      if (!session) return;
      if (session.cancelAdvanceFromIdle || cancelCheck?.()) return;
    }
    // Now show typing indicator + type delay
    emitTyping(MODERATOR_NAME, true);
    // Explanatory broadcasts use a fixed 4–6s type delay regardless of length;
    // human-paced messages type at the length-based human speed.
    const typeDelay = humanPace
      ? typingDelayMs(text)
      : randomBetween(EXPLANATORY_TYPING_DELAY_MS.min, EXPLANATORY_TYPING_DELAY_MS.max);
    await delay(typeDelay);
    if (awaitBeforeSend) await awaitBeforeSend;
    if (!session) return;
    if (session.cancelAdvanceFromIdle || cancelCheck?.()) {
      emitTyping(MODERATOR_NAME, false);
      return;
    }
    emitTyping(MODERATOR_NAME, false);
    const m = addMessage(session, MODERATOR_NAME, text);
    logLine("MESSAGE", `[${MODERATOR_NAME}] "${clip(m.text, 160)}"`);
    io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
  }

  async function advanceCallOn(opts = {}) {
    const fromHumanIdle = !!opts.fromHumanIdle;
    if (fromHumanIdle && session) session.pendingAdvanceFromIdle = true;

    if (!session?.callOnState) return;
    const co = session.callOnState;
    co.currentIndex += 1;
    co.waitingForHumanIdle = false;

    if (fromHumanIdle && wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
      return;
    }

    if (co.currentIndex >= co.order.length) {
      co.roundDone = true;
      // Commit to the ack + next phase: clear pending-advance flags now so
      // user typing can no longer skip the ack or cancel the next phase.
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
      // The first big question is a warmup — skip the disagreement/discussion phase
      // to save time and go straight to the round summary. Later big questions still
      // get the full discussion. (advanceCallOn only runs for big_question rounds,
      // so currentRoundIndex === 0 here means the first big question.)
      const skipDiscussion = session.currentRoundIndex === 0;
      logLine("QUEUE", skipDiscussion
        ? "call-on round done (first big question): acknowledging then summary, discussion skipped"
        : "call-on round done, acknowledging then view-misalignment phase");
      await emitModeratorLine(pickRoundAckText(session), { humanPace: true });
      if (!session) return;
      if (skipDiscussion) {
        runRoundSummary();
      } else {
        runDisagreementPhase();
      }
      return;
    }

    const nextName = co.order[co.currentIndex];
    const isHuman = isHumanTurn(session, nextName);
    const nameForCue = isHuman ? session.humanDisplayName : nextName;
    const latest = getLastParticipantMessage(session);
    let cue;
    try {
      cue = await generateModeratorCue(latest, nameForCue, { roundQuestion: co.question });
    } catch (e) {
      cue = `How about you, ${nameForCue}?`;
    }
    if (!session) return;
    if (fromHumanIdle && wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
      return;
    }

    if (isHuman) {
      await emitModeratorLine(cue, { humanPace: true });
      if (fromHumanIdle && wasAdvanceCancelled(session)) {
        cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
        return;
      }
      if (session) session.pendingAdvanceFromIdle = false;
      if (!session) return;
      startHumanTurnForCallOn(nextName);
      return;
    }

    // Only bot turns reach this point (the human turn returned above).
    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=${nextName}`);
    await emitModeratorLine(cue, { humanPace: true });
    if (fromHumanIdle && wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
      return;
    }
    if (session) session.pendingAdvanceFromIdle = false;
    if (!session) return;
    runBotTurn(nextName, cue);
  }

  /**
   * After a bot emits its bubbles, check whether the last thing it said contains
   * a question to the moderator. If so, have Eunice answer it (answer only — the
   * round question is never re-asked here) before the caller continues the flow.
   *
   * Returns true when Mina asked and got the fixed PASSKEY_EXPLANATION, i.e. her
   * canned follow-up is warranted. With opts.deferMinaFollowUp the follow-up is
   * NOT emitted here — the caller (runPollRound) fires it in the background so
   * the poll summary can be written concurrently and only its send waits.
   */
  async function checkAndAnswerBotQuestion(bubbles, roundQuestion, askerBotName, opts = {}) {
    const { deferMinaFollowUp = false } = opts;
    if (!Array.isArray(bubbles) || bubbles.length === 0 || !session) return false;
    const combined = bubbles.join(" ");
    let isQuestion = false;
    try {
      ({ isQuestion } = await classifyHumanMessage(
        combined,
        combined,
        { type: "call_on", prompt: roundQuestion },
        roundQuestion
      ));
    } catch (e) {
      console.error("checkAndAnswerBotQuestion classify error", e?.message || e);
    }
    if (!isQuestion || !session) return false;
    logLine("QUEUE", "bot asked a question, moderator answering");
    let answerBubbles;
    try {
      answerBubbles = await answerParticipantQuestion(combined, roundQuestion, session.answeredQuestions || []);
    } catch (e) {
      console.error("answerParticipantQuestion (bot) error", e?.message || e);
      return false;
    }
    if (!answerBubbles || answerBubbles.length === 0 || !session) return false;

    // Passkey-coordination: if this is the fixed PASSKEY_EXPLANATION, we may
    // already be "claimed" by the human_message handler. In that case skip our
    // own emit and just wait for the human path to finish; otherwise claim it
    // ourselves and emit normally.
    const isPasskeyAnswer = answerBubbles[0] === PASSKEY_EXPLANATION[0];
    const ps = session.pollState;

    if (isPasskeyAnswer && ps) {
      // NOTE: `ps.minaAskedPasskeyResolve` is now called from `runPollRound`
      // right after Mina's `emitMessage` — earlier and unconditional — so the
      // human_message handler unblocks even when Mina's answer doesn't classify
      // as a question. Not duplicated here.

      // Record that Mina asked — the human-primary emit path reads this at send
      // time to address the explanation to both askers ("Good question @Test @Mina!").
      if (askerBotName === "Mina") ps.minaAskedPasskey = true;

      if (ps.passkeyExplanationEmitPromise) {
        // Human path claimed the emit — wait for it, do not emit here.
        logLine("QUEUE", "checkAndAnswerBotQuestion: human already claimed passkey explanation, waiting");
        await ps.passkeyExplanationEmitPromise;
        if (!session) return false;
      } else {
        // We are the primary emitter. Claim the promise, emit normally, resolve.
        ps.passkeyExplanationEmitPromise = new Promise((r) => { ps.passkeyExplanationEmitResolve = r; });
        for (let i = 0; i < answerBubbles.length; i++) {
          if (!session) { ps.passkeyExplanationEmitResolve?.(); return false; }
          // Address the explanation to the asker(s): the bot who asked, plus the
          // human if they asked too before this emit (ps.humanAskedPasskey).
          const textToEmit = i === 0
            ? personalizedPasskeyExplanation([askerBotName, ps.humanAskedPasskey ? session.humanDisplayName : null])
            : answerBubbles[i];
          await emitModeratorLine(textToEmit, { consecutive: i > 0, humanPace: true });
        }
        if (session) {
          session.answeredQuestions = session.answeredQuestions || [];
          session.answeredQuestions.push({ question: combined, answer: answerBubbles[0] });
        }
        ps.passkeyExplanationEmitResolve?.();
      }
    } else {
      // Non-passkey answer path — emit normally.
      for (let i = 0; i < answerBubbles.length; i++) {
        if (!session) return false;
        await emitModeratorLine(answerBubbles[i], { consecutive: i > 0, humanPace: true });
      }
      if (session) {
        session.answeredQuestions = session.answeredQuestions || [];
        session.answeredQuestions.push({ question: combined, answer: answerBubbles[0] });
      }
    }

    // Canned Mina follow-up: only warranted when MINA asked a question that Eunice
    // then answered with the fixed PASSKEY_EXPLANATION (`isPasskeyAnswer=true`).
    // If Mina answered without asking a question (e.g., "never heard of it"),
    // `checkAndAnswerBotQuestion` has already bailed at the `if (!isQuestion)`
    // guard above, so this line is unreachable in that case. If the human primary
    // path emitted first and Mina's `answerParticipantQuestion` returned an LLM
    // recap (alreadyExplained), `isPasskeyAnswer` is false → no follow-up.
    if (session && askerBotName === "Mina" && isPasskeyAnswer) {
      // Poll rounds fire the follow-up from runPollRound in the background, so
      // Mina's bot turn can resolve now and the summary can start being "written"
      // while she types — only the summary's SEND waits for her.
      if (deferMinaFollowUp) {
        // Record her real stance HERE, synchronously — after the explanation
        // resolve above but before any microtask can let finishPollRound build
        // the summary prompt — so the summary says "haven't used it" instead of
        // quoting her question (item 23b). Written on the poll's own captured
        // state (`ps`) so it can never leak into a later poll's answers.
        if (ps && ps.answers) ps.answers["Mina"] = MINA_PASSKEY_FOLLOWUP;
        return true;
      }
      await delay(2000);
      if (!session) return true;
      emitTyping("Mina", true);
      await delay(typingDelayMs(MINA_PASSKEY_FOLLOWUP));
      if (!session) return true;
      emitTyping("Mina", false);
      emitMessage("Mina", MINA_PASSKEY_FOLLOWUP);
      if (session.pollState && session.pollState.answers) {
        session.pollState.answers["Mina"] = MINA_PASSKEY_FOLLOWUP;
      }
      return true;
    }
    return false;
  }

  async function runBotTurn(botName, directiveOverride) {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    const humanDisplayName = session.humanDisplayName;
    const humanRefName = getHumanReferenceName(session);
    const previousAnswers = co.whoSpoke.map((name) => {
      const msgName = name === session.participantName ? humanDisplayName : name;
      const msgs = session.messages.filter((m) => m.name === msgName);
      const text = msgs.map((m) => m.text).join(" ");
      // Use introduced name in transcript so bots see a consistent name
      const displayAs = msgName === humanDisplayName ? humanRefName : msgName;
      return { name: displayAs, text };
    });

    const directive =
      directiveOverride ??
      (co.currentIndex === 0 ? `Let's start with ${botName}.` : `How about you, ${botName}?`);
    const context = {
      moderatorQuestion: co.question,
      directive,
      previousAnswers,
      session,
      bots: session.bots,
    };

    const callOnWaitMs = randomBetween(BOT_THINK_DELAY_MS.min, BOT_THINK_DELAY_MS.max);
    logLine("WAIT", `${botName} start waiting for ${(callOnWaitMs / 1000).toFixed(1)}s`);
    await delay(callOnWaitMs);
    logLine("WAIT", `${botName} done waiting`);
    if (!session) return;
    const openaiStart = Date.now();
    logLine("OPENAI_REQ", `bot=${botName} question="${clip(co.question, 80)}"`);
    emitTyping(botName, true);
    let bubbles = [];
    try {
      bubbles = await getBotResponse(botName, context);
      logLine("OPENAI_OK", `bot=${botName} rtt=${Date.now() - openaiStart}ms raw="${clip(JSON.stringify(bubbles), 100)}"`);
    } catch (e) {
      logLine("OPENAI_ERR", `bot=${botName} ${e?.message || e}`);
      console.error("OpenAI error for", botName, e?.message || e);
      bubbles = ["(Sorry, I didn't get that.)"];
    }
    if (!session) return;
    emitTyping(botName, false);

    if (!Array.isArray(bubbles) || bubbles.length === 0) {
      co.whoSpoke.push(botName);
      await advanceCallOn();
      return;
    }

    await emitBotBubblesWithTyping(botName, bubbles, botTypingTimeoutRef);
    if (!session) return;
    await checkAndAnswerBotQuestion(bubbles, co.question, botName);
    if (!session) return;
    co.whoSpoke.push(botName);
    await advanceCallOn();
  }

  async function runDisagreementPhase() {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    if (co.disagreementPhase) return;
    // If user started typing after human_idle, cancel the scheduled next question and wait for idle again
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advance cancelled (user typing in view-misalignment phase), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    co.disagreementPhase = true;
    logLine("QUEUE", "view-misalignment phase started");

    // Build answersByPerson from roundTranscript (participant messages only; moderator question passed separately)
    const humanDisplayName = session.humanDisplayName;
    const answersByPerson = {};
    for (const name of co.order) {
      const msgName = name === session.participantName ? humanDisplayName : name;
      const msgs = (session.roundTranscript || []).filter(
        (m) => m.name === msgName && m.name !== MODERATOR_NAME && m.text !== co.question
      );
      const relevant = msgs.slice(-5).map((m) => m.text);
      if (relevant.length) answersByPerson[msgName] = relevant;
    }

    let pairs = [];
    try {
      pairs = await detectDisagreements(co.question, answersByPerson);
    } catch (e) {
      console.error("View-misalignment detection error", e?.message || e);
    }
    if (!session) return;
    if (wasAdvanceCancelled(session)) {
      // Same rollback as the other cancel sites in this function. Routing through
      // cancelAdvance (instead of the previous inline copy) also re-arms the idle
      // nudge timer — without it, a user who typed during detectDisagreements and
      // then walked away sat in waitingForHumanIdle with no nudge/kick escalation.
      cancelAdvance(session, "advance cancelled (user typing), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    const botNames = session.bots;
    const participantName = session.participantName;
    const toPrompt = [];
    const humanIntroName = session.introducedName || "";
    // Only names that actually have answers this round are valid resolution targets.
    // Without this, the LLM can hallucinate a non-speaker and we send a follow-up to
    // someone whose disagreedByText is empty.
    const spoke = new Set(Object.keys(answersByPerson));
    const resolve = (name) => {
      const n = String(name ?? "").trim().toLowerCase();
      // Prefer the human on a name collision: if the user introduced themselves as a
      // bot's name (e.g. "I'm Sid"), the follow-up should go to the human who spoke
      // under that name, not the bot persona.
      if (participantName && participantName.toLowerCase() === n && spoke.has(humanDisplayName)) return participantName;
      if (humanDisplayName && humanDisplayName.toLowerCase() === n && spoke.has(humanDisplayName)) return participantName;
      if (humanIntroName && humanIntroName.toLowerCase() === n && spoke.has(humanDisplayName)) return participantName;
      const bot = botNames.find((b) => b.toLowerCase() === n);
      if (bot && spoke.has(bot)) return bot;
      return null;
    };

    const orderIndex = (name) => {
      const i = co.order.indexOf(name);
      return i >= 0 ? i : 999;
    };

    for (const p of pairs) {
      let a = resolve(p.disagreedWith);
      let b = resolve(p.disagreedBy);
      if (!a || !b || a === b) continue;
      // Both must have actually spoken; resolve() already enforces this, so any
      // orderIndex==999 would be an internal bug — skip defensively.
      if (orderIndex(a) === 999 || orderIndex(b) === 999) continue;
      // disagreedWith must be the one who spoke first; swap if LLM got order wrong
      if (orderIndex(a) > orderIndex(b)) [a, b] = [b, a];
      const disagreedWithResolved = a;
      const differenceSummary = String(p.differenceSummary ?? "").trim();
      // Use display names (humanDisplayName for human) everywhere: logs, prompts, transcripts
      const disagreedWithDisplay = a === participantName ? humanDisplayName : a;
      const disagreedByDisplay = b === participantName ? humanDisplayName : b;
      const disagreedByText = Array.isArray(answersByPerson[disagreedByDisplay])
        ? answersByPerson[disagreedByDisplay].join(" ")
        : (answersByPerson[disagreedByDisplay] ?? "");
      toPrompt.push({
        disagreedWith: disagreedWithDisplay,
        disagreedBy: disagreedByDisplay,
        disagreedByText,
        differenceSummary,
        isHuman: disagreedWithResolved === participantName,
      });
    }

    // Deduplicate by (disagreedWith, disagreedBy) so we don't ask the same pair twice
    const seen = new Set();
    const deduped = toPrompt.filter((p) => {
      const key = `${p.disagreedWith}\0${p.disagreedBy}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Item 12: in the final big question, never ask Mina the disagreement follow-up,
    // so drop any pair where Mina is the one who would be asked (disagreedWith).
    const queue = (session.currentRoundIndex === lastBigQuestionIndex(session))
      ? deduped.filter((p) => p.disagreedWith !== LAST_Q_DISAGREEMENT_EXCLUDE)
      : deduped;

    co.disagreementQueue = queue;
    co.disagreementIndex = 0;
    if (queue.length === 0) {
      logLine("QUEUE", "no view misalignments to follow up");
      // The disagreement phase is bot-driven — clear stale pending-advance flags so
      // user typing during it doesn't falsely cancel the round summary / next round.
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
      runRoundSummary();
      return;
    }
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advance cancelled (user typing), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    // The disagreement follow-up loop is bot-driven. Clear stale pending-advance flags
    // so that any user typing during bot responses doesn't trigger a false cancellation
    // of advanceToNextRound (which would leave the session stuck waiting for human_idle
    // after the user has already gone idle).
    session.pendingAdvanceFromIdle = false;
    session.cancelAdvanceFromIdle = false;
    for (const p of queue) {
      logLine("QUEUE", `view misalignment: ${p.disagreedWith} ↔ ${p.disagreedBy} — ${p.differenceSummary}`);
    }
    runNextDisagreementFollowUp();
  }

  async function runRoundSummary() {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    const roundStartIndex = getRoundStartIndex(session, co.question);
    const roundMessages = session.messages.slice(roundStartIndex).filter((m) => m?.name && m?.text);
    const roundTranscript = roundMessages.map((m) => `${m.name}: ${m.text}`).join("\n");
    let summary;
    try {
      summary = await generateRoundSummary(co.question, roundTranscript);
    } catch (e) {
      console.error("Round summary error", e?.message || e);
      summary = "Thanks everyone for sharing your views on that.";
    }
    if (!session) return;
    await emitModeratorLine(summary, { humanPace: true });
    if (!session) return;
    await advanceToNextRound();
  }

  function saveCurrentRoundResponses() {
    if (!session) return;
    const ri = session.currentRoundIndex;
    if (ri == null || ri < 0) return;
    const msgs = session.humanMessagesThisRound || [];
    if (msgs.length > 0) {
      session.humanResponsesByRound[ri] = JSON.stringify(msgs);
      logLine("DB", `[${session.sessionId}] saved human responses for round ${ri}: ${msgs.length} message(s)`);
    }
  }

  async function saveSessionToDatabase(sess) {
    sess = sess || session;
    if (!sess || !dbPool) return;
    saveCurrentRoundResponses();
    const r = sess.humanResponsesByRound;
    try {
      // Focus-group duration: only computable once the chat has ended (wrap-up or kick).
      const focusGroupMs = sess.chatStartAt && sess.chatEndAt
        ? Math.max(0, sess.chatEndAt.getTime() - sess.chatStartAt.getTime())
        : null;
      await dbPool.execute(
        `INSERT INTO participant_responses
         (session_id, participant_id, assigned_group, bots_config, prolific_pid, prolific_study_id, prolific_session_id, dur_opening_ms, dur_focus_group_ms, q1_new_features, q2_vpn, q3_password_managers, q4_passkeys_heard, q5_passkey_switch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           q1_new_features = COALESCE(VALUES(q1_new_features), q1_new_features),
           q2_vpn = COALESCE(VALUES(q2_vpn), q2_vpn),
           q3_password_managers = COALESCE(VALUES(q3_password_managers), q3_password_managers),
           q4_passkeys_heard = COALESCE(VALUES(q4_passkeys_heard), q4_passkeys_heard),
           q5_passkey_switch = COALESCE(VALUES(q5_passkey_switch), q5_passkey_switch),
           prolific_pid = COALESCE(VALUES(prolific_pid), prolific_pid),
           prolific_study_id = COALESCE(VALUES(prolific_study_id), prolific_study_id),
           prolific_session_id = COALESCE(VALUES(prolific_session_id), prolific_session_id),
           dur_opening_ms = COALESCE(dur_opening_ms, VALUES(dur_opening_ms)),
           dur_focus_group_ms = COALESCE(dur_focus_group_ms, VALUES(dur_focus_group_ms))`,
        [
          sess.sessionId,
          sess.participantName,
          sess.assignedGroup === "control" ? "cont" : (sess.assignedGroup || null),
          sess.botIds ? sess.botIds.join(",") : null,
          sess.prolificPid || null,
          sess.prolificStudyId || null,
          sess.prolificSessionId || null,
          sess.openingDurationMs ?? null,
          focusGroupMs,
          r[0] || null,
          r[1] || null,
          r[2] || null,
          r[3] || null,
          r[4] || null,
        ]
      );
      logLine("DB", `[${sess.sessionId}] saved participant ${sess.participantName} responses to database`);
    } catch (e) {
      logLine("DB_ERROR", `[${sess.sessionId}] failed to save responses: ${e?.message}`);
    }
  }

  async function advanceToNextRound() {
    if (!session?.allRounds) return;
    const co = session.callOnState;
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceToNextRound cancelled (user typing), waiting for human_idle again", "last");
      return;
    }
    saveCurrentRoundResponses();
    await saveSessionToDatabase();
    const nextRoundIndex = (session.currentRoundIndex ?? -1) + 1;
    if (nextRoundIndex >= session.allRounds.length) {
      session.pendingAdvanceFromIdle = false;
      logLine("QUEUE", "all rounds done, wrapping up");
      session.chatEndAt = session.chatEndAt || new Date();
      await saveSessionToDatabase();
      await emitModeratorLine("Thanks everyone, that wraps up our discussion for today. I really appreciate you all sharing your experiences!");
      if (!session) return;
      await emitModeratorLine("To finish up, click the \"Exit Chat\" button below. You'll create an account and then complete a short exit survey. Some of the questions may be sensitive, so please set up your account with secure login credentials.", { consecutive: true });
      if (!session) return;
      await emitModeratorLine("You will also use this same account again in about two weeks for a paid follow-up study, so keep your login handy.", { consecutive: true });
      if (session) io.to(socket.id).emit("study_complete", { sessionId: session.sessionId, participantId: session.participantName });
      return;
    }
    const nextRound = session.allRounds[nextRoundIndex];
    logLine("QUEUE", `advancing to round ${nextRoundIndex + 1}/${session.allRounds.length} [${nextRound.type}]: "${clip(nextRound.question, 60)}"`);
    session.roundTranscript = [];

    if (nextRound.type === "poll" && !session.pollIntroSent) {
      session.pollIntroSent = true;
      await emitModeratorLine("For the next few questions, we're going to do a quick poll. For each question, please respond briefly — yes, no, or a short comment like \"I've only heard of it.\"");
      if (!session) return;
      await emitModeratorLine(nextRound.question, { consecutive: true });
    } else if (nextRound.type === "poll") {
      // Polls 2 & 3: prepend a short lead-in ("Moving on,") to the question in
      // the SAME bubble so the pivot reads as one continuous moderator line.
      // The last poll of the sequence uses a distinct "Lastly," pool.
      const isLastPoll = !session.allRounds
        .slice(nextRoundIndex + 1)
        .some((r) => r.type === "poll");
      const leadIn = isLastPoll
        ? pickFromPool(session, POLL_LEAD_INS_LAST, "usedPollLeadInLastIndices")
        : pickFromPool(session, POLL_LEAD_INS_MIDDLE, "usedPollLeadInMiddleIndices");
      await emitModeratorLine(withPollLeadIn(leadIn, nextRound.question));
    } else {
      // The final big question (reached here, not via startFirstRound) types at the
      // length-based human speed so it reads as personally typed.
      await emitModeratorLine(
        nextRound.question,
        nextRound.type === "big_question" ? { humanPace: true } : {}
      );
    }
    if (!session) return;
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceToNextRound cancelled (user typing during mod line), waiting for human_idle again", "last");
      return;
    }
    session.currentRoundIndex = nextRoundIndex;
    session.currentRoundType = nextRound.type;
    session.pendingAdvanceFromIdle = false;

    if (nextRound.type === "poll") {
      await runPollRound(nextRound.question);
      return;
    }

    // big_question: set call-on order (Item 11), reset state, cue first speaker.
    if (nextRoundIndex === lastBigQuestionIndex(session)) {
      // Last big question: fixed order (Sid → Anthony → Mina → user).
      co.order = buildCallOnOrder(session, LAST_BIG_Q_ORDER);
    } else {
      // Any middle big question keeps the rotate-by-one behavior.
      co.order = [...co.order.slice(1), co.order[0]];
    }
    resetCallOnState(co, nextRound.question);

    const firstSpeaker = co.order[0];
    const nameForCue = isHumanTurn(session, firstSpeaker) ? session.humanDisplayName : firstSpeaker;
    let cue;
    try {
      cue = await generateModeratorCue(null, nameForCue, { isFirstInRound: true, bigQuestion: nextRound.question });
    } catch (e) {
      cue = `Let's start with ${nameForCue}.`;
    }
    await emitModeratorLine(cue, { humanPace: true });
    if (!session) return;
    if (isHumanTurn(session, firstSpeaker)) {
      startHumanTurnForCallOn(firstSpeaker);
      return;
    }
    runBotTurn(firstSpeaker, cue);
  }

  // --- Flow: intro → study goal → big questions (call-on + disagreement) ---
  async function runIntroWithTyping() {
    if (!session) return;
    const introSegment = getModeratorScript(session.assignedGroup).find((s) => s.type === "intro");
    const introMessages = introSegment?.messages || [];
    for (let i = 0; i < introMessages.length; i++) {
      await emitModeratorLine(introMessages[i], { skipThinkDelay: i === 0, consecutive: i > 0 });
      if (!session) return;
    }
    await runIntroRound();
  }

  /** Intro: all bots start in parallel from "To start us off…" — straight to
   *  think → type → emit, no head-start stagger. To prevent random think+type
   *  durations from converging so the three emits land at the same instant
   *  (which the proxy then delivers as one batch), the emit step is gated:
   *  the first bot to finish typing emits, the next bot waits for the previous
   *  emit + a min gap. */
  async function runIntroRound() {
    if (!session?.bots?.length) return;
    logLine("QUEUE", "intro: bots all start thinking in parallel from 'To start us off', emit gated");
    let emitGate = Promise.resolve();
    const INTRO_EMIT_GAP_MS = 1500; // min gap between consecutive bot intro messages
    const botPromises = session.bots.map((bot) => {
      return (async () => {
        if (!session) return;
        const options = BOT_INTROS[bot];
        const intro = options?.length
          ? options[Math.floor(Math.random() * options.length)]
          : `Hi, I'm ${bot}.`;
        const thinkMs = randomBetween(BOT_THINK_DELAY_MS.min, BOT_THINK_DELAY_MS.max);
        logLine("WAIT", `${bot} thinking for ${(thinkMs / 1000).toFixed(1)}s`);
        await delay(thinkMs);
        if (!session) return;
        emitTyping(bot, true);
        await delay(typingDelayMs(intro));
        if (!session) return;
        // Wait for the previous bot's emit (+ gap) so two messages can't land
        // at the same time. Typing indicator stays ON while waiting — reads as
        // "still typing", which is fine for the few-second gap.
        const prev = emitGate;
        let releaseNext;
        emitGate = new Promise((r) => { releaseNext = r; });
        await prev;
        if (!session) { releaseNext(); return; }
        emitTyping(bot, false);
        emitMessage(bot, intro);
        setTimeout(releaseNext, INTRO_EMIT_GAP_MS);
      })();
    });
    await Promise.all(botPromises);
    if (!session) return;
    if (hasHumanRepliedAfterIntroPrompt(session)) {
      if (await evaluateHumanIntro(session)) {
        session.humanGaveIntro = true;
        logLine("QUEUE", `intro: human already gave a real intro after "To start us off", advancing to study_goal`);
        await runStudyGoal();
        return;
      }
      logLine("QUEUE", `intro: human replied after "To start us off" but it was not a real intro, waiting for actual introduction`);
    }
    // No moderator cue — just wait for the human to introduce themselves
    session.waitingForHumanIntro = true;
    session.humanGaveIntro = false;
    session.humanGaveSubstantiveResponseThisTurn = false;
    session.humanMessagesThisRound = [];
    session.humanMessagesBurst = [];
    session.lastPromptForHuman = { type: "intro", prompt: "Please introduce yourself—share your name and anything you feel like mentioning." };
    startIdleNudgeTimer();
    logLine("QUEUE", `waiting for human intro from ${session.humanDisplayName}`);
  }

  /** Study goal: moderator messages, then 1 ack (one random bot). */
  async function runStudyGoal() {
    if (!session || session.studyGoalStarted) return;
    // One-shot guard: the intro→study-goal transition can be reached from both the
    // human_message and human_idle handlers (and the intro-cue path). Each clears
    // waitingForHumanIntro only AFTER an async evaluateHumanIntro call, so two events
    // can race through and call runStudyGoal twice → the whole moderator flow runs in
    // parallel and every line is double-sent. Claim the transition synchronously here.
    session.studyGoalStarted = true;
    // Clear stale advance-cancel flags from intro phase so emitModeratorLine won't skip
    session.pendingAdvanceFromIdle = false;
    session.cancelAdvanceFromIdle = false;
    const segment = getModeratorScript(session.assignedGroup).find((s) => s.type === "study_goal");
    if (!segment?.messages?.length) {
      startFirstRound();
      return;
    }
    for (let i = 0; i < segment.messages.length; i++) {
      await emitModeratorLine(segment.messages[i], { consecutive: i > 0 });
      if (!session) return;
    }
    const bots = [...session.bots];
    const botIndex = Math.floor(Math.random() * bots.length);
    const bot = bots[botIndex];
    const ack = STUDY_GOAL_ACKS[Math.floor(Math.random() * STUDY_GOAL_ACKS.length)];

    // Eunice doesn't WAIT for the bot ack — she pauses 2s and moves on while the
    // ack runs concurrently in the background. Ordering (ack BEFORE the first
    // question) is guaranteed by construction, not timing arithmetic: the ack
    // task resolves `ackEmitted`, and startFirstRound passes it as the first
    // question's awaitBeforeSend — Eunice types the question while the bot acks
    // and only the SEND waits, exactly like Mina's canned follow-up gating the
    // poll summary. STUDY_GOAL_ACK_PRE_DELAY_MS can therefore be tuned freely.
    let ackEmitResolve;
    const ackEmitted = new Promise((r) => { ackEmitResolve = r; });
    (async () => {
      // Reading pause — a human needs a moment to read the two study-goal
      // bubbles before acking; an instant "Ok!" reads as bot-like.
      await delay(randomBetween(STUDY_GOAL_ACK_PRE_DELAY_MS.min, STUDY_GOAL_ACK_PRE_DELAY_MS.max));
      if (!session) return;
      emitTyping(bot, true);
      await delay(typingDelayMs(ack));
      if (!session) return;
      emitTyping(bot, false);
      emitMessage(bot, ack);
    })().finally(() => ackEmitResolve()).catch(() => {});

    await delay(2000);
    if (!session) return;

    logLine("QUEUE", "study_goal → first round (2s wait, bot ack fires in background)");
    // Bounded hold: worst legit ack = pre-delay max + ~2.5s type-out; the 10s cap
    // means a dead ack task can never stall the first question. The chained gap
    // keeps the question from posting in the same instant as the ack.
    startFirstRound({
      skipThinkDelay: true,
      holdFirstEmitFor: Promise.race([ackEmitted, delay(10000)])
        .then(() => delay(randomBetween(POST_ACK_SEND_GAP_MS.min, POST_ACK_SEND_GAP_MS.max))),
    });
  }

  /** Start first round (big_question or poll): set state, emit moderator question, then first speaker.
   *  opts.skipThinkDelay — when called from runStudyGoal, Eunice's own 2s pre-question
   *  pause already served as her think delay; skip emitModeratorLine's built-in one
   *  so the total gap stays exactly 2s instead of stacking another 3-5s on top.
   *  opts.holdFirstEmitFor — bounded promise the FIRST emit's send waits on (typing
   *  indicator stays on), used to keep the study-goal bot ack before the question. */
  async function startFirstRound(opts = {}) {
    if (!session) return;
    const skipThinkDelay = !!opts.skipThinkDelay;
    const holdFirstEmitFor = opts.holdFirstEmitFor || null;
    const firstRound = session.allRounds?.[0];
    if (!firstRound) return;
    session.currentRoundIndex = 0;
    session.currentRoundType = firstRound.type;
    session.waitingForHumanIntro = false;
    session.roundTranscript = [];
    logLine("QUEUE", `first round [${firstRound.type}]: "${clip(firstRound.question, 60)}"`);
    if (firstRound.type === "poll" && !session.pollIntroSent) {
      session.pollIntroSent = true;
      await emitModeratorLine("For the next few questions, we're going to do a quick poll. For each question, please respond briefly:yes, no, or a short comment like \"I've only heard of it.\"", { skipThinkDelay, awaitBeforeSend: holdFirstEmitFor });
      if (!session) return;
      await emitModeratorLine(firstRound.question, { consecutive: true });
    } else {
      await emitModeratorLine(firstRound.question, { skipThinkDelay, awaitBeforeSend: holdFirstEmitFor });
    }
    if (!session) return;

    if (firstRound.type === "poll") {
      await runPollRound(firstRound.question);
      return;
    }

    // big_question — first big question: fixed call-on order (Item 11).
    const co = session.callOnState;
    co.order = buildCallOnOrder(session, FIRST_BIG_Q_ORDER);
    resetCallOnState(co, firstRound.question);
    const firstSpeaker = co.order[0];
    const nameForCue = isHumanTurn(session, firstSpeaker) ? session.humanDisplayName : firstSpeaker;
    let cue;
    try {
      cue = await generateModeratorCue(null, nameForCue, { isFirstInRound: true, bigQuestion: firstRound.question });
    } catch (e) {
      cue = `Let's start with ${nameForCue}.`;
    }
    await emitModeratorLine(cue, { humanPace: true });
    if (!session) return;
    if (isHumanTurn(session, firstSpeaker)) {
      startHumanTurnForCallOn(firstSpeaker);
      return;
    }
    runBotTurn(firstSpeaker, cue);
  }

  // =====================
  // Poll round: all bots answer simultaneously, then human, then short summary
  // =====================
  async function runPollRound(question) {
    if (!session) return;
    const pollState = {
      question,
      botsFinished: false,
      humanFinished: false,
      finished: false,
      graceTimer: null,
      answers: {},
      // Passkey-poll coordination between (a) the human_message handler when
      // the participant asks "what is a passkey?" and (b) Mina's poll bot when
      // her persona-driven answer is also a passkey question. Whichever asks
      // FIRST claims `passkeyExplanationEmitPromise`; the other waits on it
      // and skips its own emit so the fixed explanation lands exactly once.
      // The human path additionally waits on `minaAskedPasskeyPromise` before
      // emitting, so the transcript reads "human asks → Mina asks → Eunice
      // explains" instead of "human asks → Eunice explains → Mina asks".
      passkeyExplanationEmitPromise: null,
      passkeyExplanationEmitResolve: null,
      minaAskedPasskeyPromise: null,
      minaAskedPasskeyResolve: null,
      // Resolved once Mina's canned follow-up has been emitted — or once her
      // turn ends without one. The follow-up fires in the BACKGROUND (her bot
      // turn resolves first, so botsFinished → the summary can start being
      // "written" a few sec after the explanation); finishPollRound gates only
      // the summary's final SEND on this, so the visible order is always
      // explanation → Mina follow-up → summary, without serializing the work.
      minaFollowUpDonePromise: null,
      minaFollowUpDoneResolve: null,
    };
    pollState.minaAskedPasskeyPromise = new Promise((r) => { pollState.minaAskedPasskeyResolve = r; });
    if (session.bots.includes("Mina")) {
      pollState.minaFollowUpDonePromise = new Promise((r) => { pollState.minaFollowUpDoneResolve = r; });
    }
    session.pollState = pollState;

    // Each bot has exactly two visible delays: (1) a thinking delay before it
    // starts typing, and (2) a typing delay for the type-out. The OpenAI call is
    // fired immediately (all bots at once) and runs CONCURRENTLY with the thinking
    // delay, so API latency hides inside the thinking phase instead of adding a
    // third wait. (No stagger — the 20–36s tails were per-minute rate-limit retries,
    // not instant concurrency, so spacing the calls only added delay for no gain.)
    const botPromises = session.bots.map((bot) => {
      const thinkMs = randomBetween(POLL_BOT_THINK_DELAY_MS.min, POLL_BOT_THINK_DELAY_MS.max);
      let minaFollowUpFired = false; // set when Mina's deferred follow-up task is launched
      const turn = new Promise(async (resolve) => {
        if (!session || pollState.finished) { resolve(); return; }

        // Fire the OpenAI call now (no typing indicator yet) and run the thinking
        // delay alongside it.
        const openaiStart = Date.now();
        logLine("OPENAI_REQ", `poll bot=${bot} question="${clip(question, 80)}"`);
        const fetchPromise = (async () => {
          try {
            const b = await getBotResponse(bot, {
              moderatorQuestion: question,
              directive: null,
              previousAnswers: [],
              session,
              bots: session.bots,
              roundType: "poll",
            });
            logLine("OPENAI_OK", `poll bot=${bot} rtt=${Date.now() - openaiStart}ms ans="${clip(JSON.stringify(b), 80)}"`);
            return b;
          } catch (e) {
            logLine("OPENAI_ERR", `poll bot=${bot} rtt=${Date.now() - openaiStart}ms ${e?.message || e}`);
            return ["Not sure."];
          }
        })();

        // (1) Thinking delay — silent, overlaps the OpenAI call.
        logLine("WAIT", `${bot} thinking for ${(thinkMs / 1000).toFixed(1)}s`);
        await delay(thinkMs);
        const bubbles = await fetchPromise; // wait for the answer only if the API is still slower than the think delay
        if (!session || pollState.finished) { resolve(); return; }

        const answer = bubbles[0] || "Not sure.";
        // (2) Typing delay — indicator stays ON for the FULL type-out of the answer.
        // The "typing…" the participant sees == this delay exactly; no hidden waiting.
        emitTyping(bot, true);
        await delay(typingDelayMs(answer));
        if (!session || pollState.finished) { emitTyping(bot, false); resolve(); return; }
        emitTyping(bot, false);
        emitMessage(bot, answer);
        if (session.pollState === pollState) pollState.answers[bot] = answer;

        // Passkey coordination — stall guard fix: as soon as Mina emits her
        // poll answer (regardless of whether the LLM produced a question form
        // like "wait whats a passkey??" or a persona-inconsistent statement
        // like "never heard of it"), unblock any human_message handler that is
        // waiting on `minaAskedPasskeyPromise` before emitting the passkey
        // explanation. Prior behavior only resolved this inside
        // `checkAndAnswerBotQuestion` (which requires Mina's answer to
        // classify as a question), so ~20-35% of runs (when gpt-4o-mini goes
        // off-persona) would stall the human path for the full 20s guard.
        if (bot === "Mina") pollState.minaAskedPasskeyResolve?.();

        // deferMinaFollowUp: when Mina asked and Eunice gave the fixed passkey
        // explanation, don't emit her canned follow-up inside cAABQ — fire it in
        // the background BELOW so this turn resolves now and the summary can
        // start being written concurrently (its SEND still waits for the
        // follow-up via minaFollowUpDonePromise — see finishPollRound).
        const minaShouldFollowUp = await checkAndAnswerBotQuestion(bubbles, question, bot, { deferMinaFollowUp: true });
        if (bot === "Mina" && minaShouldFollowUp && session) {
          minaFollowUpFired = true;
          // (Her stance is already in pollState.answers — written synchronously
          // inside checkAndAnswerBotQuestion's deferred branch, so the summary
          // prompt can never be built without it.)
          (async () => {
            // Reads as: Eunice explains → 2s "reading" pause → Mina types → ack.
            await delay(2000);
            if (!session) return;
            emitTyping("Mina", true);
            await delay(typingDelayMs(MINA_PASSKEY_FOLLOWUP));
            if (!session) return;
            emitTyping("Mina", false);
            emitMessage("Mina", MINA_PASSKEY_FOLLOWUP);
          })().finally(() => pollState.minaFollowUpDoneResolve?.());
        }
        resolve();
      });
      // If Mina's turn ends WITHOUT firing the follow-up (no passkey question,
      // suppressed straggler, session died), release the summary gate so
      // finishPollRound never waits on a follow-up that isn't coming.
      if (bot === "Mina") turn.then(() => { if (!minaFollowUpFired) pollState.minaFollowUpDoneResolve?.(); });
      return turn;
    });

    // Set up human waiting state (same idle/nudge mechanism as intro/call-on)
    const co = session.callOnState;
    co.question = question;
    co.waitingForHumanIdle = true;
    co.humanRepliedThisTurn = false;
    session.humanGaveSubstantiveResponseThisTurn = false;
    session.humanMessagesThisRound = [];
    session.humanMessagesBurst = [];
    session.lastPromptForHuman = { type: "poll", prompt: question };
    startIdleNudgeTimer();

    // Wait for all bots (they run concurrently with human's response)
    await Promise.all(botPromises);
    if (!session || session.pollState !== pollState) return;

    pollState.botsFinished = true;
    logLine("QUEUE", `poll: all bots answered. humanFinished=${pollState.humanFinished}`);
    await maybeFinishPollRound();
  }

  // Start a grace timer after the human finishes a poll, so a slow/stuck bot can't
  // freeze the round forever — once it elapses we send the summary with whatever
  // answers we have.
  function startPollStragglerGrace() {
    const ps = session?.pollState;
    if (!ps || ps.finished || ps.graceTimer) return;
    ps.graceTimer = setTimeout(() => {
      ps.graceTimer = null;
      if (!session || session.pollState !== ps || ps.finished) return;
      logLine("QUEUE", "poll: straggler grace elapsed, finishing without remaining bot(s)");
      maybeFinishPollRound(true);
    }, POLL_STRAGGLER_GRACE_MS);
  }

  // Finish when the human is done AND (all bots are done OR the grace window forced it).
  async function maybeFinishPollRound(force = false) {
    const ps = session?.pollState;
    if (!ps || ps.finished) return;
    if (!ps.humanFinished) return;            // always wait for the participant
    if (!ps.botsFinished && !force) return;   // otherwise wait for the bots
    await finishPollRound();
  }

  async function finishPollRound() {
    if (!session?.pollState || session.pollState.finished) return;
    session.pollState.finished = true;
    if (session.pollState.graceTimer) {
      clearTimeout(session.pollState.graceTimer);
      session.pollState.graceTimer = null;
    }
    // Fix B (2026-07-06): a passkey explanation queued this round runs on its own
    // async flow (checkAndAnswerBotQuestion / the human_message handler) and toggles
    // the SAME moderator "typing…" indicator as the summary + next-question emits
    // below. If it's still typing when we start, the two flows race: its
    // emitTyping(false) clears the indicator mid-message, so the participant sees a
    // long dead gap with NO "typing…" before the next question (observed ~37s). Wait
    // for any in-flight explanation to finish first, bounded by a defensive timeout
    // so a stuck/never-resolved promise can't freeze the round. NOTE: this only
    // covers the case where the explanation has ALREADY been claimed by now; see
    // note.md "Moderator typing-indicator race" for the residual edge + the full
    // (Option A) serialize-all-moderator-emits fix.
    const pendingPasskey = session.pollState.passkeyExplanationEmitPromise;
    // Gate for the summary's SEND (not its generation/typing): Mina's canned
    // follow-up fires in the background AFTER the explanation, so Eunice starts
    // "writing" the summary a few sec after the explanation and holds the final
    // send until Mina's ack has landed — visible order is always explanation →
    // Mina follow-up → summary, without serializing the work. Bounded (20s cap;
    // real remaining time after the explanation is ~7-11s) so it can never hang.
    // Only armed when an explanation was actually claimed — a stuck Mina fetch
    // on a non-passkey poll never delays a grace-forced summary.
    let holdSendForMina = null;
    if (pendingPasskey) {
      logLine("QUEUE", "finishPollRound: waiting for in-flight passkey explanation before summary/next question");
      await Promise.race([pendingPasskey, delay(45000)]);
      if (!session || !session.pollState) return;
      const minaFollowUpDone = session.pollState.minaFollowUpDonePromise;
      if (minaFollowUpDone) {
        // Chained gap: starts when Mina's follow-up lands, so the summary never
        // posts in the same instant — and adds nothing if she landed early.
        holdSendForMina = Promise.race([minaFollowUpDone, delay(20000)])
          .then(() => delay(randomBetween(POST_ACK_SEND_GAP_MS.min, POST_ACK_SEND_GAP_MS.max)));
      }
    }
    const { question, answers } = session.pollState;

    // Include human's answer(s) in the summary
    const humanDisplayName = session.humanDisplayName;
    const humanMsgs = (session.roundTranscript || [])
      .filter((m) => m.name === humanDisplayName)
      .map((m) => m.text);
    if (humanMsgs.length) answers[humanDisplayName] = humanMsgs.join(" ");

    const transcriptStr = Object.entries(answers).map(([name, text]) => `${name}: ${text}`).join("\n");
    // Fire the summary generation and run Eunice's think delay CONCURRENTLY (same
    // pattern as the poll bots' hidden OpenAI calls), so the API latency doesn't
    // stack on top of the think — typing starts right after the think delay.
    const summaryPromise = (async () => {
      try {
        return await generateRoundSummary(question, transcriptStr, { roundType: "poll" });
      } catch (e) {
        return "Thanks everyone for the quick answers!";
      }
    })();
    await delay(randomBetween(MODERATOR_THINK_DELAY_MS.min, MODERATOR_THINK_DELAY_MS.max));
    if (!session || !session.pollState) return;
    const summary = await summaryPromise;
    if (!session || !session.pollState) return;
    // skipThinkDelay: the think already ran above, alongside the generation.
    await emitModeratorLine(summary, { humanPace: true, skipThinkDelay: true, awaitBeforeSend: holdSendForMina });
    if (!session) return;
    session.pollState = null;
    // Breather before pivoting to the next question (which then runs its own
    // 3-5s think before typing) — summary → "Moving on…" read as too quick.
    await delay(randomBetween(POLL_SUMMARY_TO_NEXT_PAUSE_MS.min, POLL_SUMMARY_TO_NEXT_PAUSE_MS.max));
    if (!session) return;
    await advanceToNextRound();
  }

  async function runNextDisagreementFollowUp() {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    if (co.disagreementIndex >= co.disagreementQueue.length) {
      runRoundSummary();
      return;
    }
    if (co.disagreementIndex >= MAX_DISAGREEMENT_FOLLOWUPS) {
      logLine("QUEUE", "max disagreement follow-ups reached, running round summary");
      runRoundSummary();
      return;
    }

    const item = co.disagreementQueue[co.disagreementIndex];
    co.disagreementIndex += 1;

    // item.disagreedWith/disagreedBy already use humanDisplayName from toPrompt
    const disagreedWithForCue = item.disagreedWith;
    let followUpText;
    try {
      followUpText = await generateDisagreementFollowUp(
        disagreedWithForCue,
        item.disagreedBy,
        item.disagreedByText,
        co.question,
        item.differenceSummary
      );
    } catch (e) {
      followUpText = `${item.disagreedBy} had a different view. ${disagreedWithForCue}, what do you think?`;
    }
    if (!session) return;
    await emitModeratorLine(followUpText, { humanPace: true });
    if (!session) return;
    // If the moderator line was skipped because cancelAdvanceFromIdle was set (shouldn't
    // happen after the fix in runDisagreementPhase, but guard here as a safety net).
    if (session.cancelAdvanceFromIdle) {
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
    }

    if (item.isHuman) {
      session.waitingForHumanDisagreementResponse = true;
      session.humanRepliedDisagreementTurn = false;
      session.humanGaveSubstantiveResponseThisTurn = false;
      session.humanMessagesThisRound = [];
      session.humanMessagesBurst = [];
      session.lastPromptForHuman = { type: "disagreement", prompt: followUpText };
      startIdleNudgeTimer();
      logLine("QUEUE", `view-misalignment follow-up: waiting for human ${session.humanDisplayName} to respond (${item.differenceSummary})`);
      return;
    }

    const humanDisp = session.humanDisplayName;
    const humanRef = getHumanReferenceName(session);
    const previousAnswers = session.messages
      .filter((m) => co.order.includes(m.name) || m.name === humanDisp)
      .map((m) => ({ name: m.name === humanDisp ? humanRef : m.name, text: m.text }));
    const context = {
      moderatorQuestion: co.question,
      directive: followUpText,
      previousAnswers,
      session,
      bots: session.bots,
    };

    const botName = item.disagreedWith;
    const disagreeWaitMs = randomBetween(BOT_THINK_DELAY_MS.min, BOT_THINK_DELAY_MS.max);
    logLine("WAIT", `${botName} start waiting for ${(disagreeWaitMs / 1000).toFixed(1)}s`);
    await delay(disagreeWaitMs);
    logLine("WAIT", `${botName} done waiting`);
    if (!session) return;
    emitTyping(botName, true);
    let bubbles = [];
    try {
      bubbles = await getBotResponse(botName, context);
    } catch (e) {
      console.error("OpenAI view-misalignment follow-up error", e?.message || e);
      bubbles = ["(I'll think about it.)"];
    }
    if (!session) return;
    emitTyping(botName, false);

    if (Array.isArray(bubbles) && bubbles.length > 0) {
      await emitBotBubblesWithTyping(botName, bubbles, botTypingTimeoutRef);
    }
    if (!session) return;
    await checkAndAnswerBotQuestion(bubbles, co.question, botName);
    if (!session) return;
    await runNextDisagreementFollowUp();
  }

  socket.on("participant_name", async (data) => {
    const name = (data?.name || "").trim() || "Participant";
    session = createSession(name);
    // Store Prolific params if provided
    if (data?.prolificPid) session.prolificPid = String(data.prolificPid).trim();
    if (data?.studyId) session.prolificStudyId = String(data.studyId).trim();
    if (data?.prolificSessionId) session.prolificSessionId = String(data.prolificSessionId).trim();
    // Funnel timing: the client reports how long the participant took from opening
    // the app (consent page) to reaching the chat — measured on the client's own
    // clock, so there's no cross-clock skew. Chat start is stamped for computing
    // the focus-group duration when the chat ends.
    session.openingDurationMs = sanitizeDurationMs(data?.msSinceOpened);
    session.chatStartAt = new Date();
    logLine("SESSION_START", `id=${socket.id} bots=${session.botIds.join(",")} group=${session.assignedGroup || "cli"}`);
    logLine("SESSION_START", `participant_name set to "${name}"`);
    // Write transcript header with group info
    const transcriptPath = transcriptPathFor(session);
    try {
      const groupLabel = (session.assignedGroup || "cli").toUpperCase();
      const timestamp = new Date().toISOString();
      fs.writeFileSync(transcriptPath, [
        `=== GROUP: ${groupLabel} ===`,
        `Timestamp: ${timestamp}`,
        `Participant: ${session.humanDisplayName || session.participantName}`,
        `Session ID: ${session.sessionId}`,
        `Prolific PID: ${session.prolificPid || "(none)"}`,
        `Bots: ${session.bots.join(", ")}`,
        `Date: ${runStamp}`,
        `---`,
        ``
      ].join("\n"), "utf8");
    } catch (e) {
      console.error("Transcript header write failed", e?.message);
    }
    await saveSessionToDatabase();
    activeSessions.set(session.sessionId, session);
    socket.emit("session", {
      sessionId: session.sessionId,
      moderatorName: session.moderatorName,
      bots: session.bots,
      idleEmptyMs: IDLE_EMPTY_MS,
      idleTypingMs: IDLE_TYPING_MS,
    });
    socket.emit(
      "seed",
      session.messages.map((m) => ({ name: m.name, text: m.text, ts: m.ts }))
    );
    logLine("QUEUE", "intro: seed sent, playing moderator intro then bot intros");
    setImmediate(() => runIntroWithTyping());
  });

  /**
   * After a rejoin, the in-flight async chain from the prior socket is dead — every
   * function bailed when its `if (!session) return` guard fired on disconnect.
   * Bot turns, study-goal, and round transitions store no resume cursor, so without
   * this the chat halts forever. We infer what to re-drive from the session flags.
   *
   * Order matters: most-specific waiting state first so we don't double-drive.
   */
  function maybeResumeAfterRejoin() {
    if (!session) return;
    const co = session.callOnState;

    // 1. Waiting on the human (intro / call-on / poll / disagreement) — idle timer
    //    is already restarted below. No drive needed.
    if (
      session.waitingForHumanIntro ||
      co?.waitingForHumanIdle ||
      session.waitingForHumanDisagreementResponse
    ) {
      return;
    }

    // 2. Mid-poll: human is done (waitingForHumanIdle would be false) but the
    //    bot promises died. Force-finish so the summary goes out and we advance.
    if (session.pollState && !session.pollState.finished) {
      logLine("REJOIN", "resuming: mid-poll, force-finishing");
      maybeFinishPollRound(true);
      return;
    }

    // 3. Disagreement queue mid-flight with a bot next — re-drive.
    if (co?.disagreementPhase && co.disagreementIndex < co.disagreementQueue.length) {
      const next = co.disagreementQueue[co.disagreementIndex];
      if (next && !next.isHuman) {
        logLine("REJOIN", `resuming: disagreement follow-up for bot ${next.disagreedWith}`);
        runNextDisagreementFollowUp();
        return;
      }
    }

    // 4. Round done but we haven't started disagreement / summary / next round.
    if (co?.roundDone) {
      // disagreementPhase guard prevents re-entry — clear it if detect never produced
      // a queue (it died mid-await). Then re-run from the top.
      if (!co.disagreementPhase || co.disagreementQueue.length === 0) {
        co.disagreementPhase = false;
        logLine("REJOIN", "resuming: roundDone, re-running disagreement phase");
        runDisagreementPhase();
        return;
      }
      // disagreementPhase=true and queue exhausted → advance to next round.
      if (co.disagreementIndex >= co.disagreementQueue.length) {
        logLine("REJOIN", "resuming: post-disagreement, advancing to next round");
        advanceToNextRound();
        return;
      }
      // Otherwise case #3 should have caught a mid-queue bot follow-up.
      return;
    }

    // 5. Mid call-on with a bot next.
    //    - If the bot already has any message in this round's transcript OR is in
    //      whoSpoke, treat them as done and advance — otherwise re-driving runBotTurn
    //      would emit a fresh OpenAI response on top of any partial bubbles already
    //      visible, duplicating the bot's voice.
    //    - Otherwise re-drive their turn fresh.
    if (co && !co.roundDone) {
      const cur = co.order?.[co.currentIndex];
      if (cur && !isHumanTurn(session, cur)) {
        const botSpokeThisRound = session.roundTranscript?.some((m) => m.name === cur);
        if (co.whoSpoke.includes(cur) || botSpokeThisRound) {
          logLine("REJOIN", `resuming: ${cur} already partially/fully spoke this round, advancing call-on`);
          if (!co.whoSpoke.includes(cur)) co.whoSpoke.push(cur);
          advanceCallOn();
        } else {
          logLine("REJOIN", `resuming: mid call-on, re-driving bot ${cur}`);
          runBotTurn(cur, co.question);
        }
        return;
      }
    }

    // 6. studyGoalStarted but first round never began — finish the study-goal path.
    if (session.studyGoalStarted && (session.currentRoundIndex ?? -1) < 0) {
      logLine("REJOIN", "resuming: studyGoal interrupted, starting first round");
      startFirstRound();
      return;
    }

    // 7. Intro phase never set waitingForHumanIntro (interrupted before runIntroRound
    //    finished). Restart the intro round — it's idempotent for bots that already
    //    sent intros because addMessage just appends; the bot intros aren't
    //    deduped, so to avoid duplicate intros, only restart if no bot has spoken.
    if (!session.studyGoalStarted) {
      const anyBotSpoke = session.messages.some(
        (m) => session.bots.includes(m.name)
      );
      if (!anyBotSpoke) {
        logLine("REJOIN", "resuming: intro never completed, replaying");
        runIntroWithTyping();
      } else {
        // Bots already introduced; just wait for the human's intro.
        session.waitingForHumanIntro = true;
        session.humanGaveIntro = false;
        session.humanMessagesThisRound = [];
        session.humanMessagesBurst = [];
        session.lastPromptForHuman = { type: "intro", prompt: "Please introduce yourself—share your name and anything you feel like mentioning." };
        startIdleNudgeTimer();
        logLine("REJOIN", "resuming: intro bots already done, waiting for human intro");
      }
    }
  }

  // Rejoin an existing session after reconnect
  socket.on("rejoin", (data) => {
    const sid = data?.sessionId;
    if (!sid || !activeSessions.has(sid)) {
      socket.emit("rejoin_failed");
      return;
    }
    session = activeSessions.get(sid);
    logLine("REJOIN", `id=${socket.id} sessionId=${sid} participant=${session.humanDisplayName || session.participantName}`);
    // Re-send session info and full message history
    socket.emit("session", {
      sessionId: session.sessionId,
      moderatorName: session.moderatorName,
      bots: session.bots,
      idleEmptyMs: IDLE_EMPTY_MS,
      idleTypingMs: IDLE_TYPING_MS,
    });
    socket.emit(
      "seed",
      session.messages.map((m) => ({ name: m.name, text: m.text, ts: m.ts }))
    );
    // Restart idle timer if it's the human's turn
    if (session.callOnState?.waitingForHumanIdle || session.waitingForHumanDisagreementResponse || session.waitingForHumanIntro) {
      startIdleNudgeTimer();
    }
    // Drive any orphaned bot / round-transition that died on disconnect.
    setImmediate(maybeResumeAfterRejoin);
  });

  function clearElaborationPromptTimer() {
    if (session?.elaborationPromptTimer) {
      clearTimeout(session.elaborationPromptTimer);
      session.elaborationPromptTimer = null;
    }
    if (session) session.elaborationPromptCancelled = true;
  }

  // Watchdog: if the client says isTyping=true but never sends the matching false
  // (dropped polling packet on a flaky link), the nudge timer would defer forever.
  // Auto-clear humanIsTyping after this many ms with no further typing event.
  const HUMAN_TYPING_WATCHDOG_MS = 8000;
  socket.on("human_typing", ({ isTyping, hasDraft } = {}) => {
    if (isTyping !== undefined) logLine("TYPING", `human ${isTyping}`);
    if (session && isTyping !== undefined) session.humanIsTyping = !!isTyping;
    if (session) {
      if (session.humanTypingWatchdog) {
        clearTimeout(session.humanTypingWatchdog);
        session.humanTypingWatchdog = null;
      }
      if (isTyping) {
        session.humanTypingWatchdog = setTimeout(() => {
          if (!session) return;
          if (session.humanIsTyping) {
            session.humanIsTyping = false;
            logLine("TYPING", "human typing watchdog: auto-cleared stuck isTyping flag");
          }
          session.humanTypingWatchdog = null;
        }, HUMAN_TYPING_WATCHDOG_MS);
      }
    }
    if (isTyping && session?.waitingForElaborationAfterNonSubstantive) {
      clearElaborationPromptTimer(); // user typing again, cancel 5s countdown
    }
    if (session && isWaitingForHuman(session)) {
      session.idleLastActivityAt = Date.now();
      if (isTyping) session.idleUserHasTyped = true;
      if (hasDraft !== undefined) session.idleHasDraft = !!hasDraft;
    }
    // If we scheduled "next question" after human_idle and user started typing again, cancel and wait for idle again
    if (isTyping && session?.pendingAdvanceFromIdle) {
      session.cancelAdvanceFromIdle = true;
      logLine("QUEUE", "human_typing: cancelling scheduled advance, waiting for human_idle again");
    }
  });

  socket.on("human_idle", async () => {
    // Non-substantive response: wait for idle, then 5s before sending "elaborate" (or kick if we've already nudged 4 times)
    if (session?.waitingForElaborationAfterNonSubstantive) {
      clearElaborationPromptTimer();
      session.elaborationPromptCancelled = false;
      session.elaborationPromptTimer = setTimeout(async () => {
        if (!session) return;
        session.elaborationPromptTimer = null;
        if (session.elaborationPromptCancelled) return;
        session.waitingForElaborationAfterNonSubstantive = false;
        const nudgeCount = (session.substantialNudgeCount || 0) + 1;
        if (nudgeCount >= MAX_ELABORATION_NUDGES) {
          logLine("QUEUE", `elaboration nudge ${nudgeCount}/${MAX_ELABORATION_NUDGES}: kicking instead of nudging again`);
          await kickForUnsubstantial();
          return;
        }
        session.substantialNudgeCount = nudgeCount;
        await emitModeratorLine("Could you elaborate please?", {
          humanPace: true,
          cancelCheck: () => session?.elaborationPromptCancelled,
        });
        if (!session?.elaborationPromptCancelled) {
          session.idleNudgeCount = 0;
          session.idleLastNudgeAt = null;
          session.idleLastActivityAt = Date.now();
          logLine("QUEUE", `elaboration prompt sent after 5s idle (nudge ${session.substantialNudgeCount}/${MAX_ELABORATION_NUDGES}), idle nudge counter reset`);
        }
      }, ELABORATION_WAIT_MS);
      return;
    }
    if (session?.waitingForHumanIntro) {
      // Only advance if user actually sent a message; otherwise let the nudge timer handle it
      if (!hasHumanRepliedAfterIntroPrompt(session)) return;
      // ...and only if that message was a real introduction. A bare greeting like "hi"
      // does not count — keep waiting and let the nudge timer ask for an actual intro.
      if (!session.humanGaveIntro && !(await evaluateHumanIntro(session))) {
        logLine("QUEUE", `human_idle during intro: reply was not a real introduction yet, waiting for actual intro`);
        return;
      }
      clearIdleNudgeTimer();
      session.humanGaveIntro = true;
      logLine("QUEUE", `human_idle after intro from ${session.humanDisplayName}`);
      session.waitingForHumanIntro = false;
      await runStudyGoal();
      return;
    }
    if (session?.waitingForHumanDisagreementResponse && session.humanRepliedDisagreementTurn) {
      clearIdleNudgeTimer();
      logLine("QUEUE", `human_idle after view-misalignment response from ${session.humanDisplayName}, advancing to next follow-up or question`);
      session.waitingForHumanDisagreementResponse = false;
      session.humanRepliedDisagreementTurn = false;
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
      await runNextDisagreementFollowUp();
      return;
    }
    const co = session?.callOnState;
    if (!co?.waitingForHumanIdle) return;
    // Moderator only moves on when human has sent at least 1 message AND is idle
    if (!co.humanRepliedThisTurn) return;
    // Poll round: mark human done, then finish if bots are also done (or after a
    // grace window so one slow bot can't freeze the round).
    if (session.currentRoundType === "poll") {
      clearIdleNudgeTimer();
      logLine("QUEUE", `human_idle after poll answer from ${session.humanDisplayName}`);
      co.waitingForHumanIdle = false;
      if (session.pollState) {
        session.pollState.humanFinished = true;
        startPollStragglerGrace();
        await maybeFinishPollRound();
      }
      return;
    }
    clearIdleNudgeTimer();
    logLine("QUEUE", `human_idle from ${session.humanDisplayName} (replied this turn), advancing`);
    co.waitingForHumanIdle = false;
    session.cancelAdvanceFromIdle = false;
    await advanceCallOn({ fromHumanIdle: true });
  });

  socket.on("human_message", async (data) => {
    const text = (data?.text || "").trim();
    if (!text || !session) return;
    if (session.waitingForElaborationAfterNonSubstantive) {
      clearElaborationPromptTimer(); // user sent another message, cancel elaboration timer
      session.waitingForElaborationAfterNonSubstantive = false; // clear the flag so human_idle doesn't restart the elaboration cycle
    }
    if (session && isWaitingForHuman(session)) {
      session.idleLastActivityAt = Date.now();
      session.idleUserHasTyped = true;
      // Don't reset idleNudgeCount here — that lets a bare-greeting loop ("hi" every
      // 15s) stall the chat in intro forever. Counter is reset only when the message
      // actually progresses the flow (substantive answer, accepted intro, etc.).
    }
    logLine("HUMAN_INPUT", `[${session.humanDisplayName}] "${clip(text, 160)}"`);

    // Keep the original name from NamePage — do not update humanDisplayName from intro text

    emitMessage(session.humanDisplayName, text); // show immediately; validate below

    // Mark that the human replied IMMEDIATELY — before the async classify call.
    // This ensures human_idle can advance even if it fires during classify.
    if (session.callOnState?.waitingForHumanIdle) {
      session.callOnState.humanRepliedThisTurn = true;
    }
    if (session.waitingForHumanDisagreementResponse) {
      session.humanRepliedDisagreementTurn = true;
    }

    // Snapshot advance state BEFORE the async classify call.
    // If human_idle fires during classify and starts an advance, we must NOT cancel it —
    // the user's message was already received and the idle-triggered advance is correct.
    const advanceWasPendingBeforeClassify = !!session.pendingAdvanceFromIdle;

    // Validate response before advancing: treat non-substantive replies as if user never responded.
    // Once the user has given at least one substantive response this turn, skip further checks and just wait for idle to advance.
    const inIntroPhase = session.waitingForHumanIntro;
    const ctx = session.lastPromptForHuman || (inIntroPhase ? { type: "intro", prompt: "Please introduce yourself—share your name and anything you feel like mentioning." } : null);
    const isPollRound = session.currentRoundType === "poll";
    // Moderator-question check runs for ALL round types (including polls).
    // Substantive check is skipped for polls (they only need a short answer).
    const needResponseCheck = ctx && !session.humanGaveSubstantiveResponseThisTurn && (
      inIntroPhase ||
      session.callOnState?.waitingForHumanIdle ||
      session.waitingForHumanDisagreementResponse ||
      session.pendingAdvanceFromIdle
    );

    const roundQuestion = session.callOnState?.question || String(ctx?.prompt || "");

    if (!session.humanMessagesThisRound) session.humanMessagesThisRound = [];
    if (!session.humanMessagesBurst) session.humanMessagesBurst = [];
    session.humanMessagesThisRound.push(String(text).trim());
    session.humanMessagesBurst.push(String(text).trim());
    saveCurrentRoundResponses();
    await saveSessionToDatabase();
    const combinedText = session.humanMessagesThisRound.join(" ");
    const burstText = session.humanMessagesBurst.join(" ");

    const { isQuestion: isModQuestion, substantive, inappropriate } = await classifyHumanMessage(
      burstText, combinedText, ctx || { type: "call_on", prompt: "" }, roundQuestion
    );
    logLine("HUMAN", `classify: inappropriate=${inappropriate} isQuestion=${isModQuestion} substantive=${substantive} (burst: "${burstText.slice(0, 120)}") (combined: "${combinedText.slice(0, 120)}")`);

    if (inappropriate) {
      clearIdleNudgeTimer();
      clearElaborationPromptTimer();
      logLine("QUEUE", "human_message: inappropriate content detected, kicking user");
      session.chatEndAt = session.chatEndAt || new Date();
      await new Promise((r) => setTimeout(r, INAPPROPRIATE_KICK_DELAY_MS));
      if (session) io.to(socket.id).emit("kicked", { reason: "inappropriate", message: "You have been removed by the moderator." });
      if (session) {
        saveCurrentRoundResponses();
        await saveSessionToDatabase(session);
        activeSessions.delete(session.sessionId);
      }
      session = null;
      return;
    }

    if (needResponseCheck) {
      if (isModQuestion) {
        // Participant asked the moderator a question instead of answering the prompt.
        // Have Eunice answer it (2 bubbles) and re-ask the question; keep waiting.
        logLine("QUEUE", "human_message: question for moderator detected, generating answer");

        // Passkey-coordination path: if this is the passkey poll AND the human
        // is asking "what is a passkey?", coordinate with Mina's poll bot. We
        // want the transcript to read "human asks → Mina asks → Eunice explains"
        // so Eunice waits for Mina before emitting. Whichever side claims the
        // emit first drives it; the other waits.
        const ps = session.pollState;
        const roundIsPasskey = String(roundQuestion ?? "").toLowerCase().includes("passkey");
        if (isPollRound && roundIsPasskey && ps && (await isAskingWhatPasskeyIs(text, roundQuestion))) {
          // Record that the human asked — if Mina drives the emit, she reads this
          // to address the explanation to both ("Good question @Mina @Test!").
          ps.humanAskedPasskey = true;
          if (!ps.passkeyExplanationEmitPromise) {
            // Human is primary — drive the coordinated flow.
            logLine("QUEUE", "human_message: claiming passkey explanation, will wait for Mina");
            ps.passkeyExplanationEmitPromise = new Promise((r) => { ps.passkeyExplanationEmitResolve = r; });

            // Eunice: think delay
            const modWaitMs = randomBetween(MODERATOR_THINK_DELAY_MS.min, MODERATOR_THINK_DELAY_MS.max);
            await delay(modWaitMs);
            if (!session) { ps.passkeyExplanationEmitResolve?.(); return; }

            // Typing indicator on for the entire type-out + optional wait-for-Mina
            emitTyping(MODERATOR_NAME, true);
            await delay(typingDelayMs(PASSKEY_EXPLANATION[0]));
            if (!session) { emitTyping(MODERATOR_NAME, false); ps.passkeyExplanationEmitResolve?.(); return; }

            // Wait for Mina to ask (or 20s timeout as a stall guard).
            await Promise.race([ps.minaAskedPasskeyPromise, delay(20000)]);
            if (!session) { emitTyping(MODERATOR_NAME, false); ps.passkeyExplanationEmitResolve?.(); return; }

            // Extra 2s of typing indicator so Mina's message lands, then Eunice sends.
            await delay(2000);
            if (!session) { emitTyping(MODERATOR_NAME, false); ps.passkeyExplanationEmitResolve?.(); return; }

            emitTyping(MODERATOR_NAME, false);
            // Address the asker(s), decided at SEND time so Mina's question —
            // classified while Eunice "typed" and waited above — still counts.
            // Ask order: the human asked first on this path.
            const explanationText = personalizedPasskeyExplanation([
              session.humanDisplayName,
              ps.minaAskedPasskey ? "Mina" : null,
            ]);
            const m = addMessage(session, MODERATOR_NAME, explanationText);
            logLine("MESSAGE", `[${MODERATOR_NAME}] "${clip(m.text, 160)}"`);
            io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });

            session.answeredQuestions = session.answeredQuestions || [];
            session.answeredQuestions.push({ question: text, answer: PASSKEY_EXPLANATION[0] });
            ps.passkeyExplanationEmitResolve?.();

            session.humanMessagesBurst = [];
            if (isWaitingForHuman(session)) startIdleNudgeTimer();
            logLine("QUEUE", "human_message: passkey explanation emitted (human primary, waited for Mina)");
            return;
          } else {
            // Mina claimed. Wait for her emit, then fall through to the LLM
            // path below (session.answeredQuestions will have the passkey entry
            // by then, so answerParticipantQuestion will pick generateModeratorQuestionAnswer,
            // which produces the brief "like I mentioned above" recap).
            logLine("QUEUE", "human_message: passkey emit already claimed by Mina, waiting then LLM recap");
            await ps.passkeyExplanationEmitPromise;
            if (!session) return;
          }
        }

        let bubbles;
        try {
          bubbles = await answerParticipantQuestion(text, roundQuestion, session.answeredQuestions || []);
        } catch (e) {
          console.error("answerParticipantQuestion error", e?.message || e);
          bubbles = ["Happy to clarify!"];
        }
        if (session) {
          session.answeredQuestions = session.answeredQuestions || [];
          session.answeredQuestions.push({ question: text, answer: bubbles[0] });
        }
        for (let i = 0; i < bubbles.length; i++) {
          if (!session) return;
          // Fixed passkey explanation can reach this generic path outside the
          // poll (e.g. asked during the last big question) — address the asker.
          const textToEmit = i === 0 && bubbles[0] === PASSKEY_EXPLANATION[0]
            ? personalizedPasskeyExplanation([session.humanDisplayName])
            : bubbles[i];
          await emitModeratorLine(textToEmit, { consecutive: i > 0, humanPace: true });
        }
        if (!session) return;
        // Reset the burst so the old question doesn't leak into future isQuestion classification
        // (humanMessagesThisRound is kept intact for substantive/inappropriate checks)
        session.humanMessagesBurst = [];
        // Refresh the idle nudge timer so user has full time to answer.
        if (isWaitingForHuman(session)) startIdleNudgeTimer();
        logLine("QUEUE", "human_message: moderator answered question, waiting for user to respond to the prompt");
        return;
      }

      if (!isPollRound && !inIntroPhase) {
        if (!substantive) {
          session.waitingForElaborationAfterNonSubstantive = true;
          logLine("QUEUE", "human_message: response not substantive, waiting for idle then 5s before elaborate");
          return;
        }
        session.substantialNudgeCount = 0; // reset: user gave a substantive response
        session.waitingForElaborationAfterNonSubstantive = false;
        session.humanGaveSubstantiveResponseThisTurn = true;
        // Real progress — extinguish any nudges that were already escalating.
        session.idleNudgeCount = 0;
        session.idleLastNudgeAt = null;
        logLine("HUMAN", "human_message: response is substantive, advancing");
      } else if (isPollRound) {
        // Polls only need ANY non-question, non-inappropriate message — that's progress.
        session.idleNudgeCount = 0;
        session.idleLastNudgeAt = null;
      }
    }

    if (session.waitingForHumanIntro) {
      // Don't advance on a bare greeting like "hi" — wait until the participant actually
      // introduces themselves (shares a name and/or something about themselves).
      if (!(await evaluateHumanIntro(session))) {
        session.humanGaveIntro = false;
        logLine("QUEUE", `human_message during intro: not a real introduction yet ("${clip(text, 60)}"), waiting for actual intro`);
        return;
      }
      session.humanGaveIntro = true;
      session.waitingForHumanIntro = false;
      // Real intro accepted — extinguish nudges.
      session.idleNudgeCount = 0;
      session.idleLastNudgeAt = null;
      logLine("QUEUE", `human_message after intro: advancing to study_goal`);
      await runStudyGoal();
      return;
    }
    // Log that the human replied (flags already set before classify)
    if (session.callOnState?.waitingForHumanIdle) {
      logLine("QUEUE", `human_message during call-on: ${session.humanDisplayName} replied, waiting for idle to advance`);
    }
    if (session.waitingForHumanDisagreementResponse) {
      session.idleNudgeCount = 0;
      session.idleLastNudgeAt = null;
      logLine("QUEUE", `human_message: replied to view-misalignment follow-up, waiting for idle to advance`);
    }
    // If we're in the middle of showing the next question (mod typing) and user sent a message, cancel and roll back to waiting for human_idle.
    // BUT: only cancel if the advance was already pending BEFORE our async classify call.
    // If human_idle started the advance while classify was running, that advance is legitimate
    // (the message was already received) — cancelling it causes a deadlock where the server
    // waits for another human_idle that will never come.
    if (session.pendingAdvanceFromIdle && advanceWasPendingBeforeClassify) {
      session.cancelAdvanceFromIdle = true;
      if (session.callOnState) session.callOnState.humanRepliedThisTurn = true;
      logLine("QUEUE", "human_message during scheduled advance: cancelling, waiting for human_idle again");
    }
  });

  socket.on("auth_choice", async ({ choice }) => {
    if (!session || !dbPool) return;
    if (!["password", "passkey"].includes(choice)) return;
    try {
      await dbPool.execute(
        `UPDATE participant_responses SET auth_choice = ? WHERE session_id = ? AND participant_id = ?`,
        [choice, session.sessionId, session.participantName]
      );
      logLine("DB", `saved auth_choice=${choice} for ${session.participantName}`);
    } catch (e) {
      logLine("DB_ERROR", `failed to save auth_choice: ${e?.message}`);
    }
  });

  socket.on("disconnect", async () => {
    clearIdleNudgeTimer();
    clearElaborationPromptTimer();
    if (session?.humanTypingWatchdog) {
      clearTimeout(session.humanTypingWatchdog);
      session.humanTypingWatchdog = null;
    }
    if (session) {
      // Disconnect implies typing has ended; clear stuck flag so a future rejoin
      // can't inherit "typing forever".
      session.humanIsTyping = false;
      logLine("DISCONNECT", `id=${socket.id} sessionId=${session.sessionId} (session preserved for rejoin)`);
      saveCurrentRoundResponses();
      await saveSessionToDatabase(session);
      // Schedule cleanup after TTL — if no rejoin, remove session
      const sid = session.sessionId;
      setTimeout(() => {
        if (activeSessions.has(sid)) {
          activeSessions.delete(sid);
          logLine("SESSION_EXPIRED", `sessionId=${sid} removed after TTL`);
        }
      }, SESSION_TTL_MS);
    }
    // Don't null session — keep reference so rejoin can restore it
    session = null; // detach from this socket, but activeSessions keeps it
    if (botTypingTimeoutRef.current) clearTimeout(botTypingTimeoutRef.current);
    botTypingTimeoutRef.current = null;
  });
});

// SPA fallback: serve index.html for any non-API, non-static route
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "dist", "index.html"));
});

httpServer.listen(PORT, () => {
  logLine("SESSION_START", `backend running on http://localhost:${PORT}`);
  if (CLI_BOT_NAMES.length > 0) {
    logLine("SESSION_START", `CLI bots for this run: ${CLI_BOT_NAMES.join(", ")}`);
  }
});
