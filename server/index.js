/**
 * Study-chat server: moderator-led call-on flow.
 * No queue. Eunice (moderator) calls on one participant at a time; only that participant gets one OpenAI request (up to 3 messages).
 * Human turn: moderator advances only when human has sent at least 1 message AND is idle. Idle = no typing 3s with empty input, or no typing 7s with non-empty input.
 * After first round: detect disagreements, then prompt only the person who was disagreed WITH (one OpenAI call per).
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

  logLine("OPENAI_USER_PROMPT", userPrompt);
  logLine("OPENAI_SYS", sys);

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

  const sys = `You analyze discussion transcripts. Identify DISAGREEMENTS: one participant expressed a view and another disagreed, contradicted, or pushed back (even mildly).
Output a JSON array. Each item: { "disagreedWith": "Name of person who was disagreed with", "disagreedBy": "Name of person who disagreed" }.
Include: explicit disagreement ("I disagree", "I don't agree"), contradiction, pushback ("I see it differently", "not sure I agree", "I'd say the opposite"), or when someone corrects or challenges another's view. Use the EXACT names as they appear in the transcript.
Do NOT include: simple agreements, neutral comments, or just adding on without disagreeing.
If there are no disagreements, output: [].
Output ONLY valid JSON, no other text.`;

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: transcript },
    ],
    max_tokens: 300,
  });

  const raw = completion?.choices?.[0]?.message?.content ?? "[]";
  let arr;
  try {
    const s = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(s);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }
  return arr.filter(
    (x) =>
      x && typeof x.disagreedWith === "string" && typeof x.disagreedBy === "string"
  );
}

// =====================
// Generate follow-up prompt text for disagreed-with person (OpenAI)
// =====================
async function generateDisagreementFollowUp(disagreedWith, disagreedBy, disagreedByText, moderatorQuestion) {
  const sys = `You generate one short moderator-style sentence to ask ${disagreedWith} to respond to ${disagreedBy}'s disagreement.
Context: The moderator had asked: "${moderatorQuestion}". ${disagreedBy} said: "${(disagreedByText || "").slice(0, 300)}".
Output ONLY one sentence (e.g. "${disagreedBy} disagreed with you—what do you think about their viewpoint?"). No quotes, no JSON.`;

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "Generate the follow-up sentence." },
    ],
    max_tokens: 120,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  return text || `${disagreedBy} disagreed with you. What do you think about their viewpoint?`;
}

/** True if the message is asking what passkey is (so moderator should explain briefly). */
function isAskingWhatPasskeyIs(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    t.includes("what is passkey") ||
    t.includes("what's passkey") ||
    t.includes("what is a passkey") ||
    (t.includes("passkey") && (t.includes("what is") || t.includes("not sure what") || t.includes("don't know what")))
  );
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
    roundIsAboutPasskey && latestMessage && isAskingWhatPasskeyIs(latestMessage.text);

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
    messages: [], // intro messages sent with typing after join, not pre-loaded
    idleEmptyMs: IDLE_EMPTY_MS,
    idleTypingMs: IDLE_TYPING_MS,
    scriptIndex: 0, // 0=intro, 1=study_goal, 2..=big_question
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
  };
}

function addMessage(session, name, text) {
  const m = { name, text: String(text).trim(), ts: Date.now() };
  session.messages.push(m);
  return m;
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
  let botTypingTimeout = null;

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
      // Keep pendingAdvanceFromIdle set so human_typing can cancel before next question is shown
      co.roundDone = true;
      logLine("QUEUE", "call-on round done, running disagreement phase");
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

    for (let i = 0; i < bubbles.length; i++) {
      if (!session) return;
      if (botTypingTimeout) clearTimeout(botTypingTimeout);
      await new Promise((r) => {
        botTypingTimeout = setTimeout(r, THINKING_DELAY_MS);
      });
      if (!session) return;
      emitTyping(botName, true);
      await delay(TYPING_DELAY_MS);
      if (!session) return;
      emitTyping(botName, false);
      emitMessage(botName, bubbles[i]);
    }
    if (botTypingTimeout) {
      clearTimeout(botTypingTimeout);
      botTypingTimeout = null;
    }
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
      cancelAdvance(session, "advance cancelled (user typing in disagreement phase), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    co.disagreementPhase = true;
    logLine("QUEUE", "disagreement phase started");

    // Only include messages from the current round (after moderator asked this question)
    const questionPrefix = String(co.question).slice(0, 80);
    let roundStartIndex = 0;
    for (let i = 0; i < session.messages.length; i++) {
      const m = session.messages[i];
      if (m?.name === MODERATOR_NAME && String(m?.text || "").includes(questionPrefix)) {
        roundStartIndex = i + 1;
      }
    }

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
      console.error("Disagreement detection error", e?.message || e);
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
    for (const p of pairs) {
      let who = String(p.disagreedWith).trim();
      let by = String(p.disagreedBy).trim();
      // Normalize names (model may return different casing)
      const matchedBotWho = botNames.find((b) => b.toLowerCase() === who.toLowerCase());
      if (!matchedBotWho || matchedBotWho.toLowerCase() === by.toLowerCase()) continue;
      who = matchedBotWho;
      const byBot = botNames.find((b) => b.toLowerCase() === by.toLowerCase());
      const byHuman = participantName && participantName.toLowerCase() === by.toLowerCase();
      by = byBot || (byHuman ? participantName : by);
      if (who === by) continue;
      const byText = Array.isArray(answersByPerson[by]) ? answersByPerson[by].join(" ") : (answersByPerson[by] ?? "");
      toPrompt.push({
        disagreedWith: who,
        disagreedBy: by,
        disagreedByText: byText,
      });
    }

    co.disagreementQueue = toPrompt;
    co.disagreementIndex = 0;
    if (toPrompt.length === 0) {
      logLine("QUEUE", "no disagreements detected");
      advanceToNextQuestion();
      return;
    }
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advance cancelled (user typing), waiting for human_idle again", { rollbackIndex: "prev", clearRound: true });
      return;
    }
    logLine("QUEUE", `disagreements: ${toPrompt.map((p) => `${p.disagreedBy}->${p.disagreedWith}`).join(", ")}`);
    runNextDisagreementFollowUp();
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
    co.question = nextQuestion;
    co.whoSpoke = [];
    co.currentIndex = 0;
    co.waitingForHumanIdle = false;
    co.humanRepliedThisTurn = false;
    co.roundDone = false;
    co.disagreementPhase = false;
    co.disagreementQueue = [];
    co.disagreementIndex = 0;

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
    co.question = session.bigQuestions[0];
    co.whoSpoke = [];
    co.currentIndex = 0;
    co.waitingForHumanIdle = false;
    co.humanRepliedThisTurn = false;
    co.roundDone = false;
    co.disagreementPhase = false;
    co.disagreementQueue = [];
    co.disagreementIndex = 0;
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

  async function runNextDisagreementFollowUp() {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    if (co.disagreementIndex >= co.disagreementQueue.length) {
      advanceToNextQuestion();
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
        co.question
      );
    } catch (e) {
      followUpText = `${item.disagreedBy} disagreed with you. What do you think about their viewpoint?`;
    }
    if (!session) return;
    await emitModeratorLine(followUpText);
    if (!session) return;
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
      console.error("OpenAI disagreement follow-up error", e?.message || e);
      bubbles = ["(I'll think about it.)"];
    }
    if (!session) return;
    emitTyping(botName, false);

    if (Array.isArray(bubbles) && bubbles.length > 0) {
      for (let i = 0; i < bubbles.length; i++) {
        if (!session) return;
        if (botTypingTimeout) clearTimeout(botTypingTimeout);
        await new Promise((r) => {
          botTypingTimeout = setTimeout(r, THINKING_DELAY_MS);
        });
        if (!session) return;
        emitTyping(botName, true);
        await delay(TYPING_DELAY_MS);
        if (!session) return;
        emitTyping(botName, false);
        emitMessage(botName, bubbles[i]);
      }
    }
    if (botTypingTimeout) {
      clearTimeout(botTypingTimeout);
      botTypingTimeout = null;
    }
    if (!session) return;
    runNextDisagreementFollowUp();
  }

  // --- Socket handlers ---
  socket.on("participant_name", (data) => {
    const name = (data?.name || "").trim() || "Participant";
    session = createSession(name);
    logLine("SESSION_START", `id=${socket.id} bots=${session.bots.join(",")}`);
    logLine("SESSION_START", `participant_name set to "${name}"`);
    socket.emit("session", {
      sessionId: session.sessionId,
      moderatorName: session.moderatorName,
      bots: session.bots,
      idleEmptyMs: session.idleEmptyMs,
      idleTypingMs: session.idleTypingMs,
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
    if (botTypingTimeout) clearTimeout(botTypingTimeout);
    botTypingTimeout = null;
  });
});

httpServer.listen(PORT, () => {
  logLine("SESSION_START", `backend running on http://localhost:${PORT}`);
  if (CLI_BOT_NAMES.length > 0) {
    logLine("SESSION_START", `CLI bots for this run: ${CLI_BOT_NAMES.join(", ")}`);
  }
});
