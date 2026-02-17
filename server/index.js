/**
 * Study-chat server: moderator-led call-on flow.
 * No queue. Eunice (moderator) calls on one participant at a time; only that participant gets one OpenAI request (up to 3 messages).
 * Human turn: moderator advances only when human has sent at least 1 message AND is idle. Idle = no typing 3s with empty input, or no typing 7s with non-empty input.
 * After first round: detect view misalignments (disagreedWith/disagreedBy/differenceSummary), then prompt each "person to ask" to respond (one OpenAI call per).
 */

import "dotenv/config";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import {
  pickRandomCast,
  getCastByHandles,
  systemPrompt,
  buildUserPrompt,
} from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bot names from CLI: npm start -- Jae Mina Derek (optional; if empty, spawn random cast)
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
// Constants
// =====================
const IDLE_EMPTY_MS = 4000;   // Human idle: empty input, no typing this long
const IDLE_TYPING_MS = 10000; // Human idle: non-empty input, no typing this long
const MODERATOR_NAME = "Eunice";

const MODERATOR_SCRIPT = [
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
      "Before we dive in, just a quick note about the goal of this study.\nWe are interested in how people experience new features introduced by large tech companies, and how they decide whether to adopt them or not.",
      "There are no right or wrong answers here. Feel free to talk openly about your own experiences with technology.",
    ],
  },
  {
    type: "big_question",
    messages: [
      "First question: Big tech companies like Google roll out new features pretty often.\n\nHow do you usually feel when a company you use introduces something new?\nDo you tend to try new features right away, or do you usually ignore them at first?",
    ],
  },
  {
    type: "big_question",
    messages: [
      "Moving on, one of the new popular technology is generative AI such as Gemini and Chat GPT\n\nHave any of you used them before?\nWhat made you try it, or what made you decide not to?",
    ],
  },
  {
    type: "big_question",
    messages: [
      "Sometimes when companies introduce new features, they also change how accounts work behind the scenes.\nHave you noticed changes to how you access or manage your account over time?\nDo those changes usually feel helpful or annoying?",
    ],
  },
  {
    type: "big_question",
    messages: [
      "For some Google accounts, users can switch their account login to \"passkey\".\n\nHave you seen or heard about passkey before?\nIf you've used it, what made you decide to switch? If you haven't, what held you back?",
    ],
  },
];

const STUDY_GOAL_ACKS = ["Got it!", "Ok!", "Sure!"];
const STUDY_GOAL_ACK_DELAY_MS = { min: 2000, max: 3000 };
const THINKING_DELAY_MS = 1000;  // before showing typing indicator
const TYPING_DELAY_MS = 3200;    // how long typing shows before message

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let MODELS = { default: "gpt-4o-mini" };
try {
  const raw = fs.readFileSync(path.join(__dirname, "models.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.default) MODELS.default = parsed.default;
} catch (e) {
  console.warn("Using default gpt-4o-mini (models.json not found or invalid)");
}

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
  const { moderatorQuestion, directive, previousAnswers, humanParticipantName } = context;
  const cast = getCastByHandles([botName]);
  const persona = cast[0] || {};
  const bots = context.bots || [botName];
  const others = bots.filter((n) => n !== botName).join(", ") || "others";

  const sys = systemPrompt(
    botName,
    others,
    persona,
    MODERATOR_NAME,
    humanParticipantName || "You"
  );

  const transcriptLines = [];
  transcriptLines.push(`${MODERATOR_NAME}: ${moderatorQuestion}`);
  for (const a of previousAnswers) {
    transcriptLines.push(`${a.name}: ${a.text}`);
  }
  if (directive) {
    transcriptLines.push(`${MODERATOR_NAME}: ${directive}`);
  }
  const transcript = transcriptLines.join("\n");

  const recentBot = previousAnswers
    .filter((a) => a.name !== botName)
    .map((a) => a.text)
    .join(" | ") || "(none)";

  const maxBubbles = Math.min(3, Math.max(1, Number(persona.max_bubbles) || 3));

  const userPrompt = buildUserPrompt({
    transcript,
    recentBot,
    recentQs: moderatorQuestion,
    mode: "human",
    botName,
    otherName: others,
    respondTo: directive ? { type: "directive", text: directive } : null,
    moderatorName: MODERATOR_NAME,
    humanParticipantName: humanParticipantName || "You",
    maxBubbles,
  });

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxBubbles <= 2 ? 400 : 600,
  });

  const raw =
    completion?.choices?.[0]?.message?.content ?? "";
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

This does NOT require:
- Direct replies to each other.
- Explicit phrases like “I disagree”.
- Pushback or confrontation.

Make sure that disagreedWith is the participant who went before disagreedBy in the transcript.

For every pair of participants whose views differ meaningfully, output an object:

{
  "disagreedWith": "Name",
  "disagreedBy": "Name",
  "differenceSummary": "Brief explanation of how their views differ"
}

Output a separate object for each pair whose views differ. If multiple participants share a similar stance that contrasts with another participant, include each such pair (e.g. if both Sid and Jae contrast with Vivian, output both Sid–Vivian and Jae–Vivian).

Use EXACT names as they appear in the transcript.

If all participants express essentially the same stance, output: [].

Output ONLY valid JSON. No extra text.`;

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: transcript },
    ],
    max_tokens: 800,
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
  const fallback = `${disagreedBy} had a different view—${disagreedWith}, what do you think?`;
  const sys = `You generate one short human moderator-style sentence. You must ask ${disagreedWith} (and only ${disagreedWith}) to respond. The sentence must be directed AT ${disagreedWith}—do NOT address ${disagreedBy} as the person being asked (${disagreedBy} already gave their view). End with or clearly name ${disagreedWith}, e.g. "... what do you think, ${disagreedWith} or ... ${disagreedWith}, can you share your thoughts on ${disagreedBy}'s idea?" You may tell them that it is idea from ${disagreedBy}. Do not use any separators like ---, --, -, ;, :, or similar or any markdown or formatting."
Context: The moderator had asked: "${moderatorQuestion}". View misalignment: ${(differenceSummary || "").slice(0, 200)}. ${disagreedBy} said: "${(disagreedByText || "").slice(0, 200)}".
Output ONLY one sentence. No quotes, no JSON.`;

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "Generate the follow-up sentence." },
    ],
    max_tokens: 120,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  const out = text || fallback;
  if (!out.toLowerCase().includes(disagreedWith.toLowerCase())) return fallback;
  return out;
}

/** Generate a short moderator summary of the round discussion (OpenAI). */
async function generateRoundSummary(question, roundTranscript) {
  const sys = `You are a discussion moderator wrapping up a conversation. In 2–3 short sentences, naturally summarize what was shared. Highlight the main themes and briefly note where participants had different perspectives. Speak in a warm, conversational moderator voice (e.g., "We heard a range of reactions...", "Some of you felt..., while others..."). Keep it concise and natural. Output ONLY the summary, no labels or quotes. Thank them before you start the summary. Do not use any separators like ---, --, -, ;, :, or similar or any markdown or formatting.`;
  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Question: ${question}\n\nDiscussion:\n${roundTranscript}` },
    ],
    max_tokens: 200,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  return text || "Thanks everyone for sharing your views on that.";
}

/** True if the participant's message indicates they don't know what passkey is and are asking for an explanation. Uses OpenAI for classification. */
async function isAskingWhatPasskeyIs(text, roundQuestion) {
  if (!text || typeof text !== "string") return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;

  const sys = `You classify whether a chat message indicates the participant does NOT know what passkey is and is asking for an explanation.

Return ONLY valid JSON: {"asksWhatPasskeyIs": true} or {"asksWhatPasskeyIs": false}.

True when: the participant explicitly or implicitly asks what passkey is, expresses confusion, says they don't know, or requests an explanation.
False when: they already know, are sharing an opinion, or are not seeking an explanation.`;

  const user = `Round context: ${String(roundQuestion ?? "").slice(0, 150)}

Participant message: "${trimmed.slice(0, 300)}"

Does this message indicate the participant doesn't know what passkey is and is asking for an explanation?`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 20,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return !!parsed.asksWhatPasskeyIs;
  } catch (e) {
    console.error("isAskingWhatPasskeyIs error", e?.message || e);
    return false;
  }
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

  const sys = `You are a discussion moderator. Generate ONE short message that:
1. Briefly acknowledges the latest message (one short phrase, then cue the next person)
2. Then cues the next person to speak (e.g. "[Name], what do you think?" or "How about you, [Name]?")

ACKNOWLEDGMENT VARIETY: Vary your acknowledgment phrases. Use different ones throughout the conversation. Examples:
- "Thanks for sharing, [Name]."
- "That's interesting, [Name]."
- "I see, [Name]."
- "Got it, [Name]."
- "Right, [Name]."
- "Makes sense, [Name]."
- "Thanks, [Name]."
- "Good point, [Name]." (use sparingly, not every time)
- "Interesting perspective, [Name]."
- "Thanks for that, [Name]."
- "[Name], that's helpful."
- "Appreciate that, [Name]."

Keep it natural and conversational. Output ONLY the message text—no JSON, no quotes, no extra formatting. Do NOT use "---" or similar separators.
When you are in the middle of a round, do NOT ask a new or different question—only acknowledge and cue the next person to respond to the same question for this round.`;

  let userPrompt;
  if (participantAskedWhatPasskeyIs) {
    userPrompt = `A participant just asked what passkey is. First give ONE short sentence explaining passkey (e.g. it's a way to sign in with your face, fingerprint, or device instead of a password). Then briefly acknowledge and cue the next person: ${nextName}. Output one flowing message: explanation + ack + cue.`;
  } else if (isIntro) {
    userPrompt = `The latest message: ${latestStr}. Next person to cue: ${nextName}. Write a brief ack and then ask ${nextName} to introduce themselves.`;
  } else if (isFirstInRound && bigQuestion) {
    userPrompt = `We're starting a new question: "${String(bigQuestion).slice(0, 300)}". No one has answered this question yet. Cue ${nextName} to answer first (brief transition only, e.g. "[Name], what do you think?"). Do NOT thank or acknowledge anyone as having just responded—no one has responded to this question yet.`;
  } else if (roundQuestion) {
    userPrompt = `The current question for this round is: "${String(roundQuestion).slice(0, 300)}". Latest message to acknowledge: ${latestStr}. Next person to cue: ${nextName}. Brief ack, then cue them to respond to this same question. Do NOT introduce a new or different question.`;
  } else {
    userPrompt = `Latest message to acknowledge: ${latestStr}. Next person to cue: ${nextName}. Brief ack, then cue them.`;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 100,
    });
    const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
    if (text) return text.replace(/---/g, "").trim() || `How about you, ${nextName}?`;
  } catch (e) {
    console.error("generateModeratorCue error", e?.message || e);
  }
  return `How about you, ${nextName}?`;
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

/** True if the human has sent any message after Eunice's last "To start us off" intro prompt. */
function hasHumanRepliedAfterIntroPrompt(session) {
  if (!session?.messages?.length || !session.participantName) return false;
  let lastIntroPromptIndex = -1;
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    if (m?.name === MODERATOR_NAME && String(m?.text || "").includes("To start us off")) {
      lastIntroPromptIndex = i;
    }
  }
  if (lastIntroPromptIndex < 0) return false;
  for (let i = lastIntroPromptIndex + 1; i < session.messages.length; i++) {
    if (session.messages[i]?.name === session.participantName) return true;
  }
  return false;
}

// =====================
// Session state (one per socket/room)
// =====================
function createSession(participantName) {
  const cast =
    CLI_BOT_NAMES.length > 0
      ? getCastByHandles(CLI_BOT_NAMES)
      : pickRandomCast(3);
  const bots = cast.map((p) => p.handle);
  if (CLI_BOT_NAMES.length > 0 && bots.length === 0) {
    console.warn("CLI bot names matched no personas; falling back to random cast.");
    const fallback = pickRandomCast(3);
    fallback.forEach((p) => bots.push(p.handle));
  } else if (CLI_BOT_NAMES.length > 0 && bots.length < CLI_BOT_NAMES.length) {
    console.warn(`Only ${bots.length} of ${CLI_BOT_NAMES.length} CLI names matched: ${bots.join(", ")}`);
  }
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const order = [...bots, participantName];
  const bigQuestionSegments = MODERATOR_SCRIPT.filter((s) => s.type === "big_question");
  const bigQuestions = bigQuestionSegments.map((s) => s.messages[0]);

  return {
    sessionId,
    moderatorName: MODERATOR_NAME,
    bots,
    participantName,
    messages: [],
    scriptIndex: 0,
    waitingForHumanIntro: false,
    moderatorTypingIntroCue: false,
    userRepliedDuringIntroCue: false,
    callOnState: {
      question: bigQuestions[0] || "",
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
    bigQuestions,
    usedRoundAckIndices: [],
  };
}

function addMessage(session, name, text) {
  const m = { name, text: String(text).trim(), ts: Date.now() };
  session.messages.push(m);
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
// Bot intro messages (one chosen at random per bot)
// =====================
const BOT_INTROS = {
  Jae: [
    "Hi I'm Jae. I teach math at high school",
    "Hey all! I'm Jae. I'm a math teacher at a high school in D.C."
  ],
  Mina: [
    "Hi, I'm Mina. I work in retail in LA. Nice to meet you all",
    "Hiii my name is Mina! I work in retail in LA",
    "Hi yall! I'm Mina. First time doing this kind of thing!",
  ],
  Derek: [
    "Hi, I'm Derek. I'm a case worker in Tacoma.",
    "Hey, I'm Derek. I work in social services. Good to see you all.",
    "I am Derek. I'm in Tacoma.",
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
const app = express();
app.use(cors());
// Serve profile pictures so client can load participant avatars (profile_1.jpg … profile_9.jpg)
const profilePicturesDir = path.join(__dirname, "..", "profile_pictures");
app.use("/profile_pictures", express.static(profilePicturesDir));
const httpServer = createServer(app);
// CORS: withCredentials requires explicit origins (no "*")
const CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3001;

// =====================
// Socket: per-connection state and helpers
// =====================
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

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomBetween(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /** Emit a bot's message bubbles with typing indicators; uses timeoutRef so disconnect can clear pending delay. */
  async function emitBotBubblesWithTyping(botName, bubbles, timeoutRef) {
    if (!Array.isArray(bubbles)) return;
    for (let i = 0; i < bubbles.length; i++) {
      if (!session) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      await new Promise((r) => {
        timeoutRef.current = setTimeout(r, THINKING_DELAY_MS);
      });
      if (!session) return;
      emitTyping(botName, true);
      await delay(TYPING_DELAY_MS);
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
  }

  function wasAdvanceCancelled(session) {
    return !!(session?.pendingAdvanceFromIdle && session?.cancelAdvanceFromIdle);
  }

  async function emitModeratorLine(text, opts = {}) {
    const { skipIfUserReplied: skipIfUserRepliedDuringCue } = opts;
    if (!session) return;
    if (session.cancelAdvanceFromIdle) return;
    emitTyping(MODERATOR_NAME, true);
    await delay(THINKING_DELAY_MS);
    if (session?.cancelAdvanceFromIdle) {
      emitTyping(MODERATOR_NAME, false);
      return;
    }
    await delay(TYPING_DELAY_MS);
    if (!session) return;
    if (session.cancelAdvanceFromIdle) {
      emitTyping(MODERATOR_NAME, false);
      return;
    }
    if (skipIfUserRepliedDuringCue && session.userRepliedDuringIntroCue) {
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
      logLine("QUEUE", "call-on round done, acknowledging then view-misalignment phase");
      await emitModeratorLine(pickRoundAckText(session));
      if (!session) return;
      runDisagreementPhase();
      return;
    }

    const nextName = co.order[co.currentIndex];
    const isHuman = nextName === session.participantName;
    const latest = getLastParticipantMessage(session);
    let cue;
    try {
      cue = await generateModeratorCue(latest, nextName, { roundQuestion: co.question });
    } catch (e) {
      cue = `How about you, ${nextName}?`;
    }
    if (!session) return;
    if (fromHumanIdle && wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
      return;
    }

    if (isHuman) {
      logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=human ${nextName}, waiting for human_idle`);
      await emitModeratorLine(cue);
      if (fromHumanIdle && wasAdvanceCancelled(session)) {
        cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
        return;
      }
      if (session) session.pendingAdvanceFromIdle = false;
      if (!session) return;
      co.waitingForHumanIdle = true;
      co.humanRepliedThisTurn = false;
      return;
    }

    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=${nextName}`);
    await emitModeratorLine(cue);
    if (fromHumanIdle && wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
      return;
    }
    if (session) session.pendingAdvanceFromIdle = false;
    if (!session) return;
    runBotTurn(nextName, cue);
  }

  async function runBotTurn(botName, directiveOverride) {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    const previousAnswers = co.whoSpoke.map((name) => {
      const msgs = session.messages.filter((m) => m.name === name);
      const text = msgs.map((m) => m.text).join(" ");
      return { name, text };
    });

    const directive =
      directiveOverride ??
      (co.currentIndex === 0 ? `Let's start with ${botName}.` : `How about you, ${botName}?`);
    const context = {
      moderatorQuestion: co.question,
      directive,
      previousAnswers,
      humanParticipantName: session.participantName,
      bots: session.bots,
    };

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

    const roundStartIndex = getRoundStartIndex(session, co.question);
    const answersByPerson = {};
    for (const name of co.order) {
      const msgs = session.messages
        .slice(roundStartIndex)
        .filter((m) => m.name === name && !m.text.startsWith("How about you") && m.text !== co.question);
      const relevant = msgs.slice(-5).map((m) => m.text);
      if (relevant.length) answersByPerson[name] = relevant;
    }

    let pairs = [];
    try {
      pairs = await detectDisagreements(co.question, answersByPerson);
    } catch (e) {
      console.error("View-misalignment detection error", e?.message || e);
    }
    if (!session) return;
    if (session.pendingAdvanceFromIdle && session.cancelAdvanceFromIdle) {
      co.currentIndex -= 1;
      co.waitingForHumanIdle = true;
      co.humanRepliedThisTurn = true;
      co.roundDone = false;
      co.disagreementPhase = false;
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
      logLine("QUEUE", "advance cancelled (user typing), waiting for human_idle again");
      return;
    }
    const botNames = session.bots;
    const participantName = session.participantName;
    const toPrompt = [];
    const resolve = (name) =>
      botNames.find((b) => b.toLowerCase() === String(name ?? "").trim().toLowerCase())
        || (participantName && participantName.toLowerCase() === String(name ?? "").trim().toLowerCase() ? participantName : null);

    for (const p of pairs) {
      const disagreedWith = resolve(p.disagreedWith);
      const disagreedBy = resolve(p.disagreedBy);
      if (!disagreedWith || !disagreedBy || disagreedWith === disagreedBy) continue;
      const differenceSummary = String(p.differenceSummary ?? "").trim();
      const disagreedByText = Array.isArray(answersByPerson[disagreedBy])
        ? answersByPerson[disagreedBy].join(" ")
        : (answersByPerson[disagreedBy] ?? "");
      toPrompt.push({
        disagreedWith,
        disagreedBy,
        disagreedByText,
        differenceSummary,
        isHuman: disagreedWith === participantName,
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

    co.disagreementQueue = deduped;
    co.disagreementIndex = 0;
    if (deduped.length === 0) {
      logLine("QUEUE", "no view misalignments detected");
      runRoundSummary();
      return;
    }
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advance cancelled (user typing), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    session.lastViewMisalignments = deduped.map((p) => ({ disagreedWith: p.disagreedWith, disagreedBy: p.disagreedBy, differenceSummary: p.differenceSummary }));
    for (const p of deduped) {
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
    await emitModeratorLine(summary);
    if (!session) return;
    await advanceToNextQuestion();
  }

  async function advanceToNextQuestion() {
    if (!session?.bigQuestions) return;
    const co = session.callOnState;
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceToNextQuestion cancelled (user typing), waiting for human_idle again", "last");
      return;
    }
    // Don't clear pendingAdvanceFromIdle or update state yet — emit next question first so human_typing can cancel during moderator typing
    const nextScriptIndex = (session.scriptIndex ?? 2) + 1;
    const bigQuestionIndex = nextScriptIndex - 2; // scriptIndex 2 -> first big_question
    if (bigQuestionIndex >= session.bigQuestions.length) {
      session.pendingAdvanceFromIdle = false;
      logLine("QUEUE", "all questions done, wrapping up");
      await emitModeratorLine("Thanks everyone, that wraps up our discussion for today!");
      return;
    }
    const nextQuestion = session.bigQuestions[bigQuestionIndex];
    logLine("QUEUE", `advancing to question ${bigQuestionIndex + 1}/${session.bigQuestions.length}: "${clip(nextQuestion, 60)}"`);
    await emitModeratorLine(nextQuestion);
    if (!session) return;
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceToNextQuestion cancelled (user typing during mod line), waiting for human_idle again", "last");
      return;
    }
    session.scriptIndex = nextScriptIndex;
    session.pendingAdvanceFromIdle = false;
    resetCallOnState(co, nextQuestion);

    const firstBot = co.order[0];
    let cue;
    try {
      cue = await generateModeratorCue(null, firstBot, { isFirstInRound: true, bigQuestion: nextQuestion });
    } catch (e) {
      cue = `Let's start with ${firstBot}.`;
    }
    await emitModeratorLine(cue);
    if (!session) return;
    runBotTurn(firstBot, cue);
  }

  // --- Flow: intro → study goal → big questions (call-on + disagreement) ---
  async function runIntroWithTyping() {
    if (!session) return;
    const introSegment = MODERATOR_SCRIPT.find((s) => s.type === "intro");
    const introMessages = introSegment?.messages || [];
    for (const text of introMessages) {
      await emitModeratorLine(text);
      if (!session) return;
    }
    await runIntroRound();
  }

  /** Intro: all bots start their timer as soon as "To start us off..." is shown; 1st bot 1–2s, 2nd 1–3s, 3rd 1–4s, etc. */
  async function runIntroRound() {
    if (!session?.bots?.length) return;
    logLine("QUEUE", "intro: bots start staggered timers from 'To start us off', type in parallel");
    const botPromises = session.bots.map((bot, i) => {
      const maxSec = 2 + i;
      const staggerMs = randomBetween(1000, maxSec * 1000);
      return new Promise((resolve) => {
        setTimeout(async () => {
          await delay(THINKING_DELAY_MS);
          emitTyping(bot, true);
          await delay(TYPING_DELAY_MS);
          emitTyping(bot, false);
          const options = BOT_INTROS[bot];
          const intro = options?.length
            ? options[Math.floor(Math.random() * options.length)]
            : `Hi, I'm ${bot}.`;
          emitMessage(bot, intro);
          resolve();
        }, staggerMs);
      });
    });
    await Promise.all(botPromises);
    if (!session) return;
    if (hasHumanRepliedAfterIntroPrompt(session)) {
      logLine("QUEUE", `intro: human already replied after "To start us off", advancing to study_goal`);
      await runStudyGoal();
      return;
    }
    const latest = getLastParticipantMessage(session);
    let cue;
    try {
      cue = await generateModeratorCue(latest, session.participantName, { isIntro: true });
    } catch (e) {
      cue = `How about you, ${session.participantName}?`;
    }
    if (!session) return;
    session.moderatorTypingIntroCue = true;
    await emitModeratorLine(cue, { skipIfUserReplied: true });
    if (!session) return;
    session.moderatorTypingIntroCue = false;
    if (session.userRepliedDuringIntroCue) {
      session.userRepliedDuringIntroCue = false;
      logLine("QUEUE", "intro cue cancelled: user already sent intro, advancing to study_goal");
      return;
    }
    session.waitingForHumanIntro = true;
    logLine("QUEUE", `waiting for human intro from ${session.participantName}`);
  }

  /** Study goal: moderator messages, then 1 ack (one random bot). */
  async function runStudyGoal() {
    if (!session) return;
    const segment = MODERATOR_SCRIPT.find((s) => s.type === "study_goal");
    if (!segment?.messages?.length) {
      startFirstBigQuestion();
      return;
    }
    for (const text of segment.messages) {
      await emitModeratorLine(text);
      if (!session) return;
    }
    const bots = [...session.bots];
    const botIndex = Math.floor(Math.random() * bots.length);
    const bot = bots[botIndex];
    const ack = STUDY_GOAL_ACKS[Math.floor(Math.random() * STUDY_GOAL_ACKS.length)];
    await delay(randomBetween(STUDY_GOAL_ACK_DELAY_MS.min, STUDY_GOAL_ACK_DELAY_MS.max));
    emitMessage(bot, ack);

    logLine("QUEUE", "study_goal ack done, starting first big_question");
    startFirstBigQuestion();
  }

  /** Start first big_question: set question, emit moderator, run first bot. */
  async function startFirstBigQuestion() {
    if (!session) return;
    session.scriptIndex = 2;
    session.waitingForHumanIntro = false;
    const co = session.callOnState;
    resetCallOnState(co, session.bigQuestions[0]);
    const firstBot = co.order[0];
    logLine("QUEUE", `first big_question: "${clip(co.question, 60)}"`);
    await emitModeratorLine(co.question);
    if (!session) return;
    let cue;
    try {
      cue = await generateModeratorCue(null, firstBot, { isFirstInRound: true, bigQuestion: co.question });
    } catch (e) {
      cue = `Let's start with ${firstBot}.`;
    }
    await emitModeratorLine(cue);
    if (!session) return;
    runBotTurn(firstBot, cue);
  }

  const MAX_DISAGREEMENT_FOLLOWUPS = 20;

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

    let followUpText;
    try {
      followUpText = await generateDisagreementFollowUp(
        item.disagreedWith,
        item.disagreedBy,
        item.disagreedByText,
        co.question,
        item.differenceSummary
      );
    } catch (e) {
      followUpText = `${item.disagreedBy} had a different view. ${item.disagreedWith}, what do you think?`;
    }
    if (!session) return;
    await emitModeratorLine(followUpText);
    if (!session) return;

    if (item.isHuman) {
      session.waitingForHumanDisagreementResponse = true;
      session.humanRepliedDisagreementTurn = false;
      logLine("QUEUE", `view-misalignment follow-up: waiting for human ${session.participantName} to respond (${item.differenceSummary})`);
      return;
    }

    const previousAnswers = session.messages
      .filter((m) => co.order.includes(m.name))
      .map((m) => ({ name: m.name, text: m.text }));
    const context = {
      moderatorQuestion: co.question,
      directive: followUpText,
      previousAnswers,
      humanParticipantName: session.participantName,
      bots: session.bots,
    };

    const botName = item.disagreedWith;
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
    await runNextDisagreementFollowUp();
  }

  socket.on("participant_name", (data) => {
    const name = (data?.name || "").trim() || "Participant";
    session = createSession(name);
    logLine("SESSION_START", `id=${socket.id} bots=${session.bots.join(",")}`);
    logLine("SESSION_START", `participant_name set to "${name}"`);
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

  socket.on("human_typing", ({ isTyping } = {}) => {
    if (isTyping !== undefined) logLine("TYPING", `human ${isTyping}`);
    // If we scheduled "next question" after human_idle and user started typing again, cancel and wait for idle again
    if (isTyping && session?.pendingAdvanceFromIdle) {
      session.cancelAdvanceFromIdle = true;
      logLine("QUEUE", "human_typing: cancelling scheduled advance, waiting for human_idle again");
    }
  });

  socket.on("human_idle", async () => {
    if (session?.waitingForHumanIntro) {
      logLine("QUEUE", `human_idle after intro from ${session.participantName}`);
      session.waitingForHumanIntro = false;
      await runStudyGoal();
      return;
    }
    if (session?.waitingForHumanDisagreementResponse && session.humanRepliedDisagreementTurn) {
      logLine("QUEUE", `human_idle after view-misalignment response from ${session.participantName}, advancing to next follow-up or question`);
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
    logLine("QUEUE", `human_idle from ${session.participantName} (replied this turn), advancing`);
    co.waitingForHumanIdle = false;
    session.cancelAdvanceFromIdle = false;
    await advanceCallOn({ fromHumanIdle: true });
  });

  socket.on("human_message", async (data) => {
    const text = (data?.text || "").trim();
    if (!text || !session) return;
    logLine("HUMAN_INPUT", `[${session.participantName}] "${clip(text, 160)}"`);
    const repliedWhileModeratorTypingIntroCue = !!session.moderatorTypingIntroCue;
    if (repliedWhileModeratorTypingIntroCue) {
      session.userRepliedDuringIntroCue = true;
      session.moderatorTypingIntroCue = false;
    }
    emitMessage(session.participantName, text);
    if (repliedWhileModeratorTypingIntroCue) {
      logLine("QUEUE", "human_message during intro cue: cancelling cue, advancing to study_goal");
      await runStudyGoal();
      return;
    }
    if (session.waitingForHumanIntro) {
      session.waitingForHumanIntro = false;
      logLine("QUEUE", `human_message after intro: advancing to study_goal`);
      await runStudyGoal();
      return;
    }
    // When it's the human's turn: mark that they replied; do NOT advance yet—wait for human_idle
    if (session.callOnState?.waitingForHumanIdle) {
      session.callOnState.humanRepliedThisTurn = true;
      logLine("QUEUE", `human_message during call-on: ${session.participantName} replied, waiting for idle to advance`);
    }
    if (session.waitingForHumanDisagreementResponse) {
      session.humanRepliedDisagreementTurn = true;
      logLine("QUEUE", `human_message: replied to view-misalignment follow-up, waiting for idle to advance`);
    }
    // If we're in the middle of showing the next question (mod typing) and user sent a message, cancel and roll back to waiting for human_idle
    if (session.pendingAdvanceFromIdle) {
      session.cancelAdvanceFromIdle = true;
      if (session.callOnState) session.callOnState.humanRepliedThisTurn = true;
      logLine("QUEUE", "human_message during scheduled advance: cancelling, waiting for human_idle again");
    }
  });

  socket.on("disconnect", () => {
    if (session) logLine("DISCONNECT", `id=${socket.id}`);
    session = null;
    if (botTypingTimeoutRef.current) clearTimeout(botTypingTimeoutRef.current);
    botTypingTimeoutRef.current = null;
  });
});

httpServer.listen(PORT, () => {
  logLine("SESSION_START", `backend running on http://localhost:${PORT}`);
  if (CLI_BOT_NAMES.length > 0) {
    logLine("SESSION_START", `CLI bots for this run: ${CLI_BOT_NAMES.join(", ")}`);
  }
});
