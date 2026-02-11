/**
 * Study-chat server: moderator-led call-on flow.
 * No queue. Eunice (moderator) calls on one participant at a time; only that participant gets one OpenAI request (up to 3 messages).
 * Human turn: wait for human_idle (idle = empty input no typing 4s, or non-empty no typing 10s) OR when user sends a message (advance immediately).
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
// Constants (easy to change at top of code)
// =====================
const IDLE_EMPTY_MS = 4000;   // Participant idle when text box empty and no typing for this long
const IDLE_TYPING_MS = 10000; // Participant idle when text box not empty and no typing for this long
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
    thenAcks: 2, // 2 random bots say "Got it!" / "Ok!" / "Sure!" with 1–2s delay
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
      "For some Google accounts, users can switch their account login to *passkey*.\n\nHave you seen or heard about passkey before?\nIf you've used it, what made you decide to switch? If you haven't, what held you back?",
    ],
  },
];

const STUDY_GOAL_ACKS = ["Got it!", "Ok!", "Sure!"];
const BOT_INTRO_STAGGER_MS_MIN = 1000;
const BOT_INTRO_STAGGER_MS_MAX = 3000;
const STUDY_GOAL_FIRST_ACK_DELAY_MS_MIN = 2000;
const STUDY_GOAL_FIRST_ACK_DELAY_MS_MAX = 3000;
const STUDY_GOAL_SECOND_ACK_DELAY_MS = 1000;
const BOT_THINKING_DELAY_MS = 1000;  // Delay before showing "typing" for each bubble (thinking phase)
const BOT_TYPING_DELAY_MS = 3200;   // How long typing indicator shows before each message bubble
const MODERATOR_THINKING_DELAY_MS = 1000;  // Moderator "thinking" before typing
const MODERATOR_TYPING_DELAY_MS = 3200;   // Moderator typing indicator before message
const CONDITION = "control";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let MODELS = { default: "gpt-4o-mini", bots: {} };
try {
  const raw = fs.readFileSync(path.join(__dirname, "models.json"), "utf8");
  MODELS = JSON.parse(raw);
  if (!MODELS.bots) MODELS.bots = {};
} catch (e) {
  console.warn("Using default gpt-4o-mini (models.json not found or invalid)");
}

function getModelForBot(/* botName */) {
  return MODELS.default;
}

// =====================
// Helpers
// =====================
function buildTranscript(messages, maxLines = 50) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .slice(-maxLines)
    .map((m) => `${m.name}: ${(m.text || "").trim()}`)
    .filter((line) => line.length > 0)
    .join("\n");
}

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

function ts() {
  return Date.now();
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
    CONDITION,
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
  });

  const model = getModelForBot(botName);
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 600,
  });

  const raw =
    completion?.choices?.[0]?.message?.content ?? "";
  return parseJsonArray(raw, 3);
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

  const sys = `You analyze discussion transcripts. Identify only CLEAR DISAGREEMENTS: one participant expressed a view and another explicitly disagreed or contradicted them.
Output a JSON array. Each item: { "disagreedWith": "Name of person who was disagreed with", "disagreedBy": "Name of person who disagreed" }.
Only include real disagreements (e.g. "I don't agree", "I disagree", "I don't think so", contradiction). Do NOT include agreements, neutral comments, or uninteresting overlap.
If there are no clear disagreements, output: [].
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

// =====================
// Generate moderator cue: short ack of latest message + cue next person (OpenAI)
// =====================
async function generateModeratorCue(latestMessage, nextName, opts = {}) {
  const { isFirstInRound = false, isIntro = false, bigQuestion, roundQuestion } = opts;
  const latestStr = latestMessage
    ? `${latestMessage.name} said: "${String(latestMessage.text || "").slice(0, 200)}"`
    : "(no prior message)";

  const sys = `You are a discussion moderator. Generate ONE short message that:
1. Briefly acknowledges the latest message (one short phrase, e.g. "Good point.", "Thanks for sharing.", "Got it.")
2. Then cues the next person to speak (e.g. "[Name], what do you think?" or "How about you, [Name]?")
Keep it natural and conversational. Output ONLY the message text—no JSON, no quotes, no extra formatting. Do NOT use "---" or similar separators.
When you are in the middle of a round, do NOT ask a new or different question—only acknowledge and cue the next person to respond to the same question for this round.`;

  let userPrompt;
  if (isIntro) {
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
  const cast = pickRandomCast(3);
  const bots = cast.map((p) => p.handle);
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const order = [...bots, participantName];
  const bigQuestionSegments = MODERATOR_SCRIPT.filter((s) => s.type === "big_question");
  const bigQuestions = bigQuestionSegments.map((s) => s.messages[0]);

  return {
    sessionId,
    moderatorName: MODERATOR_NAME,
    bots,
    condition: CONDITION,
    participantName,
    messages: [], // intro messages sent with typing after join, not pre-loaded
    idleEmptyMs: IDLE_EMPTY_MS,
    idleTypingMs: IDLE_TYPING_MS,
    scriptIndex: 0, // 0=intro, 1=study_goal, 2..=big_question
    waitingForHumanIntro: false,
    callOnState: {
      question: bigQuestions[0] || "",
      order,
      whoSpoke: [],
      currentIndex: 0,
      waitingForHumanIdle: false,
      roundDone: false,
      disagreementPhase: false,
      disagreementQueue: [],
      disagreementIndex: 0,
    },
    bigQuestions,
  };
}

function addMessage(session, name, text) {
  const m = { name, text: String(text).trim(), ts: ts() };
  session.messages.push(m);
  return m;
}

/** Hardcoded intro options per bot (2–3 sentences). One is chosen at random. */
const BOT_INTROS = {
  Jae: [
    "Hi, I'm Jae. I teach math at high school",
    "Hey all! I'm Jae. I'm a math teacher at a high school in D.C."
  ],
  Mina: [
    "Hi, I'm Mina. I work in retail in LA and I'm on my phone a lot. Honestly I just want things to be easy.",
    "Hey, I'm Mina Yujin. I use Instagram and TikTok constantly. If an app adds something new I usually ignore it until I have to.",
    "I'm Mina. I live in Koreatown and I hate when apps make me do extra steps. The simpler the better.",
  ],
  Derek: [
    "Hi, I'm Derek. I'm a case worker in Tacoma. I deal with a lot of systems at work and I'm pretty tired of things changing all the time.",
    "Hey, I'm Derek Matthew. I work in social services. To be honest I've seen too many \"upgrades\" that just make everything harder.",
    "I'm Derek. I'm in Tacoma and I use a lot of government portals. I care about security but I also just want to get through my day.",
  ],
  Vivian: [
    "Hi, I'm Vivian. I'm a psych undergrad at Emory. I'm on my phone 24/7 and I barely think about logging in—it just happens.",
    "Hey, I'm Vivian Mae. I'm in Atlanta and I use Notion, Discord, all of that. Passwords feel so outdated to me.",
    "I'm Vivian. I'm a student and I multitask a lot. My phone is basically my identity at this point.",
  ],
  Anika: [
    "Hi, I'm Anika. I'm a massage therapist in Fremont. I prefer simple things—I don't really like complicated apps or settings.",
    "Hey, I'm Anika Riya. I run my own practice and use my phone for booking and stuff. If it works I don't touch it.",
    "I'm Anika. I do yoga and cooking when I'm not working. I keep tech pretty minimal. I don't need a lot of new features.",
  ],
  Alex: [
    "Hi, I'm Alex. I work at a bank in Bellevue. I use fingerprint and face login a lot—we're pretty focused on security.",
    "Hey, I'm Alex Wei. I'm in banking so I think about risk and procedures. I like biometrics but I don't really follow the latest terms.",
    "I'm Alex. I'm in Washington and I use LinkedIn and Reddit. I'm fine with new login options as long as they're secure.",
  ],
  Dario: [
    "Hi, I'm Dario. I bartend in Austin. I'm on social media a lot but I don't dig into how login stuff works.",
    "Hey, I'm Dario. I'm in Texas and I use my phone for everything. New features? I'll try them if they're obvious.",
    "I'm Dario. I work nights so I'm on my phone between shifts. I just want things to work without thinking about it.",
  ],
  Faith: [
    "Hi, I'm Faith. I'm a nurse and we use a lot of systems at the hospital. I'm careful about security but I also need things to be fast.",
    "Hey, I'm Faith. I work in healthcare so I see a lot of logins. I like when things get easier—face ID and that kind of thing.",
    "I'm Faith. I'm in nursing and we're always short on time. I prefer logins that don't make me stop and think.",
  ],
  Sid: [
    "Hi, I'm Sid. I'm in grad school and I use a ton of apps for research and writing. I'm pretty comfortable with tech.",
    "Hey, I'm Sid. I'm a student and I'm always trying new tools. Some stick and some don't—I just see what works.",
    "I'm Sid. I live on my laptop and phone. I've heard of passkeys and stuff but I don't always keep up with the names.",
  ],
  Alayna: [
    "Hi, I'm Alayna. I work in marketing and I'm on Instagram and TikTok a lot. I like when apps feel smooth and modern.",
    "Hey, I'm Alayna. I'm pretty active online. New features? I'll try them if they look good and don't get in the way.",
    "I'm Alayna. I care about how things look and feel. If a company rolls out something new I might try it if it's easy.",
  ],
  Lukas: [
    "Hi, I'm Lukas. I'm in software but I don't obsess over every new feature. I use what works for me.",
    "Hey, I'm Lukas. I work in tech in the Bay Area. I've heard of passkeys and similar stuff—some of it's useful.",
    "I'm Lukas. I'm a developer so I'm used to new tools. I adopt things when they actually make my life easier.",
  ],
  Camille: [
    "Hi, I'm Camille. I'm in design and I use a lot of creative apps. I like when login doesn't interrupt my flow.",
    "Hey, I'm Camille. I work with design tools and collaboration apps. I'm fine with Face ID and things like that.",
    "I'm Camille. I'm pretty visual and I get annoyed when tech gets in the way. Simple logins are best.",
  ],
  Erik: [
    "Hi, I'm Erik. I'm in sales and I'm on the road a lot. I use my phone for everything—the less typing the better.",
    "Hey, I'm Erik. I travel for work so I need logins that work everywhere. I've used fingerprint and face login for years.",
    "I'm Erik. I'm in sales and I hate resetting passwords. I'm open to anything that makes signing in faster.",
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

io.on("connection", (socket) => {
  let session = null;
  let botTypingTimeout = null;

  function broadcast(msg) {
    if (!session) return;
    io.to(socket.id).emit(msg.event, msg.payload);
  }

  function emitTyping(who, isTyping) {
    const label = session?.bots?.includes(who) ? `bot=${who}` : who === MODERATOR_NAME ? "moderator" : "human";
    logLine("TYPING", `${label} ${isTyping}`);
    io.to(socket.id).emit("typing", { who, isTyping });
  }

  function emitMessage(name, text) {
    const m = addMessage(session, name, text);
    logLine("MESSAGE", `[${name}] "${clip(m.text, 160)}"`);
    io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
  }

  async function emitModeratorLine(text) {
    emitTyping(MODERATOR_NAME, true);
    await new Promise((r) => setTimeout(r, MODERATOR_THINKING_DELAY_MS));
    await new Promise((r) => setTimeout(r, MODERATOR_TYPING_DELAY_MS));
    emitTyping(MODERATOR_NAME, false);
    const m = addMessage(session, MODERATOR_NAME, text);
    logLine("MESSAGE", `[${MODERATOR_NAME}] "${clip(m.text, 160)}"`);
    io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
  }

  async function advanceCallOn() {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    co.currentIndex += 1;
    co.waitingForHumanIdle = false;

    if (co.currentIndex >= co.order.length) {
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

    if (isHuman) {
      logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=human ${nextName}, waiting for human_idle`);
      await emitModeratorLine(cue);
      co.waitingForHumanIdle = true;
      return;
    }

    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=${nextName}`);
    await emitModeratorLine(cue);
    runBotTurn(nextName, cue);
  }

  async function runBotTurn(botName, directiveOverride) {
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
    emitTyping(botName, false);

    if (!Array.isArray(bubbles) || bubbles.length === 0) {
      co.whoSpoke.push(botName);
      await advanceCallOn();
      return;
    }

    for (let i = 0; i < bubbles.length; i++) {
      if (botTypingTimeout) clearTimeout(botTypingTimeout);
      // Thinking phase: delay before showing typing indicator
      await new Promise((r) => {
        botTypingTimeout = setTimeout(r, BOT_THINKING_DELAY_MS);
      });
      emitTyping(botName, true);
      // Typing phase: show typing indicator for a bit before sending the message
      await new Promise((r) => setTimeout(r, BOT_TYPING_DELAY_MS));
      emitTyping(botName, false);
      emitMessage(botName, bubbles[i]);
    }
    if (botTypingTimeout) {
      clearTimeout(botTypingTimeout);
      botTypingTimeout = null;
    }

    co.whoSpoke.push(botName);
    await advanceCallOn();
  }

  async function runDisagreementPhase() {
    const co = session.callOnState;
    if (co.disagreementPhase) return;
    co.disagreementPhase = true;
    logLine("QUEUE", "disagreement phase started");

    const answersByPerson = {};
    for (const name of co.order) {
      const msgs = session.messages.filter((m) => m.name === name && !m.text.startsWith("How about you") && m.text !== co.question);
      const relevant = msgs.slice(-5).map((m) => m.text);
      if (relevant.length) answersByPerson[name] = relevant;
    }

    let pairs = [];
    try {
      pairs = await detectDisagreements(co.question, answersByPerson);
    } catch (e) {
      console.error("Disagreement detection error", e?.message || e);
    }

    const botNames = session.bots;
    const toPrompt = [];
    for (const p of pairs) {
      const who = String(p.disagreedWith).trim();
      const by = String(p.disagreedBy).trim();
      if (botNames.includes(who) && who !== by) {
        toPrompt.push({
          disagreedWith: who,
          disagreedBy: by,
          disagreedByText: Array.isArray(answersByPerson[by]) ? answersByPerson[by].join(" ") : "",
        });
      }
    }

    co.disagreementQueue = toPrompt;
    co.disagreementIndex = 0;
    if (toPrompt.length === 0) {
      logLine("QUEUE", "no disagreements detected");
      advanceToNextQuestion();
      return;
    }
    logLine("QUEUE", `disagreements: ${toPrompt.map((p) => `${p.disagreedBy}->${p.disagreedWith}`).join(", ")}`);
    runNextDisagreementFollowUp();
  }

  async function advanceToNextQuestion() {
    if (!session?.bigQuestions) return;
    session.scriptIndex = (session.scriptIndex ?? 2) + 1;
    const bigQuestionIndex = session.scriptIndex - 2; // scriptIndex 2 -> first big_question
    if (bigQuestionIndex >= session.bigQuestions.length) {
      logLine("QUEUE", "all questions done, wrapping up");
      await emitModeratorLine("Thanks everyone, that wraps up our discussion for today!");
      return;
    }
    const co = session.callOnState;
    const nextQuestion = session.bigQuestions[bigQuestionIndex];
    co.question = nextQuestion;
    co.whoSpoke = [];
    co.currentIndex = 0;
    co.waitingForHumanIdle = false;
    co.roundDone = false;
    co.disagreementPhase = false;
    co.disagreementQueue = [];
    co.disagreementIndex = 0;

    const firstBot = co.order[0];
    logLine("QUEUE", `advancing to question ${bigQuestionIndex + 1}/${session.bigQuestions.length}: "${clip(nextQuestion, 60)}"`);
    await emitModeratorLine(nextQuestion);
    let cue;
    try {
      cue = await generateModeratorCue(null, firstBot, { isFirstInRound: true, bigQuestion: nextQuestion });
    } catch (e) {
      cue = `Let's start with ${firstBot}.`;
    }
    await emitModeratorLine(cue);
    runBotTurn(firstBot, cue);
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomBetween(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /** Plays moderator intro messages with typing, then bot intros with typing, then cue. */
  async function runIntroWithTyping() {
    const introSegment = MODERATOR_SCRIPT.find((s) => s.type === "intro");
    const introMessages = introSegment?.messages || [];
    for (const text of introMessages) {
      await emitModeratorLine(text);
    }
    await runIntroRound();
  }

  /** Intro: hardcoded bot intros (1–3s stagger + typing), then AI-generated cue for human. */
  async function runIntroRound() {
    if (!session?.bots?.length) return;
    logLine("QUEUE", "intro: bots stagger 1–3s with typing, then human");
    for (const bot of session.bots) {
      await delay(randomBetween(BOT_INTRO_STAGGER_MS_MIN, BOT_INTRO_STAGGER_MS_MAX));
      if (botTypingTimeout) clearTimeout(botTypingTimeout);
      await new Promise((r) => {
        botTypingTimeout = setTimeout(r, BOT_THINKING_DELAY_MS);
      });
      emitTyping(bot, true);
      await new Promise((r) => setTimeout(r, BOT_TYPING_DELAY_MS));
      emitTyping(bot, false);
      const options = BOT_INTROS[bot];
      const intro = options?.length
        ? options[Math.floor(Math.random() * options.length)]
        : `Hi, I'm ${bot}.`;
      emitMessage(bot, intro);
    }
    if (botTypingTimeout) {
      clearTimeout(botTypingTimeout);
      botTypingTimeout = null;
    }
    if (hasHumanRepliedAfterIntroPrompt(session)) {
      logLine("QUEUE", `intro: human already replied after "To start us off", skipping cue`);
      return;
    }
    const latest = getLastParticipantMessage(session);
    let cue;
    try {
      cue = await generateModeratorCue(latest, session.participantName, { isIntro: true });
    } catch (e) {
      cue = `How about you, ${session.participantName}?`;
    }
    await emitModeratorLine(cue);
    session.waitingForHumanIntro = true;
    logLine("QUEUE", `waiting for human intro from ${session.participantName}`);
  }

  /** Study goal: moderator messages, then 2 acks (2–3s then 1s, random bots). */
  async function runStudyGoal() {
    const segment = MODERATOR_SCRIPT.find((s) => s.type === "study_goal");
    if (!segment?.messages?.length) {
      startFirstBigQuestion();
      return;
    }
    for (const text of segment.messages) {
      await emitModeratorLine(text);
    }
    const bots = [...session.bots];
    const firstBotIndex = Math.floor(Math.random() * bots.length);
    const firstBot = bots[firstBotIndex];
    const secondBotCandidates = bots.filter((_, i) => i !== firstBotIndex);
    const secondBot = secondBotCandidates[Math.floor(Math.random() * secondBotCandidates.length)];

    const firstAck = STUDY_GOAL_ACKS[Math.floor(Math.random() * STUDY_GOAL_ACKS.length)];
    const secondAck = STUDY_GOAL_ACKS[Math.floor(Math.random() * STUDY_GOAL_ACKS.length)];

    await delay(randomBetween(STUDY_GOAL_FIRST_ACK_DELAY_MS_MIN, STUDY_GOAL_FIRST_ACK_DELAY_MS_MAX));
    emitMessage(firstBot, firstAck);
    await delay(STUDY_GOAL_SECOND_ACK_DELAY_MS);
    emitMessage(secondBot, secondAck);

    logLine("QUEUE", "study_goal acks done, starting first big_question");
    startFirstBigQuestion();
  }

  /** Start first big_question: set question, emit moderator, run first bot. */
  async function startFirstBigQuestion() {
    session.scriptIndex = 2;
    session.waitingForHumanIntro = false;
    const co = session.callOnState;
    co.question = session.bigQuestions[0];
    co.whoSpoke = [];
    co.currentIndex = 0;
    co.waitingForHumanIdle = false;
    co.roundDone = false;
    co.disagreementPhase = false;
    co.disagreementQueue = [];
    co.disagreementIndex = 0;
    const firstBot = co.order[0];
    logLine("QUEUE", `first big_question: "${clip(co.question, 60)}"`);
    await emitModeratorLine(co.question);
    let cue;
    try {
      cue = await generateModeratorCue(null, firstBot, { isFirstInRound: true, bigQuestion: co.question });
    } catch (e) {
      cue = `Let's start with ${firstBot}.`;
    }
    await emitModeratorLine(cue);
    runBotTurn(firstBot, cue);
  }

  async function runNextDisagreementFollowUp() {
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

    await emitModeratorLine(followUpText);

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
    emitTyping(botName, false);

    if (Array.isArray(bubbles) && bubbles.length > 0) {
      for (let i = 0; i < bubbles.length; i++) {
        if (botTypingTimeout) clearTimeout(botTypingTimeout);
        await new Promise((r) => {
          botTypingTimeout = setTimeout(r, BOT_THINKING_DELAY_MS);
        });
        emitTyping(botName, true);
        await new Promise((r) => setTimeout(r, BOT_TYPING_DELAY_MS));
        emitTyping(botName, false);
        emitMessage(botName, bubbles[i]);
      }
    }
    if (botTypingTimeout) {
      clearTimeout(botTypingTimeout);
      botTypingTimeout = null;
    }

    runNextDisagreementFollowUp();
  }

  socket.on("participant_name", (data) => {
    const name = (data?.name || "").trim() || "Participant";
    session = createSession(name);
    logLine("SESSION_START", `id=${socket.id} condition=${session.condition} bots=${session.bots.join(",")}`);
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
  });

  socket.on("human_idle", async () => {
    if (session?.waitingForHumanIntro) {
      logLine("QUEUE", `human_idle after intro from ${session.participantName}`);
      session.waitingForHumanIntro = false;
      await runStudyGoal();
      return;
    }
    if (!session?.callOnState?.waitingForHumanIdle) return;
    logLine("QUEUE", `human_idle from ${session.participantName}`);
    await advanceCallOn();
  });

  socket.on("human_message", async (data) => {
    const text = (data?.text || "").trim();
    if (!text || !session) return;
    logLine("HUMAN_INPUT", `[${session.participantName}] "${clip(text, 160)}"`);
    emitMessage(session.participantName, text);
    if (session.waitingForHumanIntro) {
      session.waitingForHumanIntro = false;
      logLine("QUEUE", `human_message after intro: advancing to study_goal`);
      await runStudyGoal();
      return;
    }
    // When it's the human's turn and they send a message, advance immediately so the next participant is called
    if (session.callOnState?.waitingForHumanIdle) {
      session.callOnState.waitingForHumanIdle = false;
      logLine("QUEUE", `human_message during call-on: advancing after ${session.participantName}'s response`);
      await advanceCallOn();
    }
  });

  socket.on("end", () => {
    // Optional: persist sessionId for login flow
  });

  socket.on("disconnect", () => {
    if (session) logLine("DISCONNECT", `id=${socket.id}`);
    if (botTypingTimeout) clearTimeout(botTypingTimeout);
  });
});

httpServer.listen(PORT, () => {
  logLine("SESSION_START", `backend running on http://localhost:${PORT}`);
});
