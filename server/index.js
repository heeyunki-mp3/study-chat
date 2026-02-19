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

/** Append one line to the session transcript file (same pattern as log file). */
function appendTranscriptLine(session, name, text) {
  if (!session?.sessionId) return;
  const transcriptPath = path.join(LOG_DIR, `transcript_${runStamp}_${session.sessionId}.txt`);
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
// Constants
// =====================
const IDLE_EMPTY_MS = 4000;   // Human idle: empty input, no typing this long
const IDLE_TYPING_MS = 10000; // Human idle: non-empty input, no typing this long
const NUDGE_MS = 20000;                     // Nudge after 20s of no typing (or 30s if has draft in input)
const NUDGE_AFTER_TYPING_WITH_DRAFT_MS = 30000; // Nudge if user stopped typing for 30s (has draft)
const MAX_NUDGES = 2;                       // After 2 nudges with no response, kick out
const MAX_ELABORATION_NUDGES = 4;           // After Eunice has sent "Could you elaborate?" 4 times (without a substantive response), kick out
const ELABORATION_WAIT_MS = 5000;          // After user goes idle, wait 5s before sending "elaborate"
const MODERATOR_NAME = "Eunice";

/** Try to extract a name from intro text (e.g. "I'm heeyun", "My name is Alice"). Returns null if none found. */
function extractIntroducedName(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();
  const patterns = [
    /\b(?:I'?m|I am)\s+([A-Za-z][A-Za-z'-]*)/i,
    /\b(?:my name is|call me|name'?s)\s+([A-Za-z][A-Za-z'-]*)/i,
    /\b(?:this is|it'?s)\s+([A-Za-z][A-Za-z'-]*)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/** Capitalize first character of a name. */
function capitalizeFirst(s) {
  if (!s || typeof s !== "string") return s ?? "";
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
}

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
      "Before we dive in, just a quick note about the goal of this study. We are interested in how people experience new features introduced by large tech companies, and how they decide whether to adopt them or not.",
      "We will go one at a time, so please respond when I call your name. \n\nThere are no right or wrong answers. Just share your honest experiences with technology",
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
      "Moving on, one of the new popular technologies is generative AI – things like Gemini and Chat GPT\n\nHave any of you used them before?\nWhat made you try it, or what made you decide not to?"     
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
  const { moderatorQuestion, directive, previousAnswers, session, roundType = "big_question" } = context;
  const humanDisplayName = session?.humanDisplayName || session?.participantName || "You";
  const cast = getCastByHandles([botName]);
  const persona = cast[0] || {};
  const bots = context.bots || [botName];
  const others = bots.filter((n) => n !== botName).join(", ") || "others";

  const sys = systemPrompt(
    botName,
    others,
    persona,
    MODERATOR_NAME,
    humanDisplayName
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

  const maxBubbles = roundType === "poll" ? 1 : Math.min(3, Math.max(1, Number(persona.max_bubbles) || 3));

  const userPrompt = buildUserPrompt({
    transcript,
    recentBot,
    recentQs: moderatorQuestion,
    mode: "human",
    botName,
    otherName: others,
    respondTo: directive ? { type: "directive", text: directive } : null,
    moderatorName: MODERATOR_NAME,
    humanParticipantName: humanDisplayName,
    maxBubbles,
    questionType: roundType,
  });

  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
    max_tokens: roundType === "poll" ? 60 : maxBubbles <= 2 ? 400 : 600,
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

/** Generate a moderator summary of the round. Pass opts.roundType to control behavior per question type. */
async function generateRoundSummary(question, roundTranscript, opts = {}) {
  const { roundType = "big_question" } = opts;
  const sys = roundType === "poll"
    ? `You are a discussion moderator. Given a yes/no/heard-of poll question and each participant's short answer, write ONE casual sentence summarizing how many people have used it / heard of it vs haven't. Example: "Looks like 2 of us use VPNs and 2 don't!" or "Interesting — 3 out of 4 have heard of passkeys but only 1 has actually used one." Keep it under 20 words, warm and natural. Output ONLY the sentence, no quotes or extra text.`
    : `You are a discussion moderator wrapping up a conversation. In 2–3 short sentences, naturally summarize what was shared. Highlight the main themes and briefly note where participants had different perspectives. Speak in a warm, conversational moderator voice (e.g., "We heard a range of reactions...", "Some of you felt..., while others..."). Keep it concise and natural. Output ONLY the summary, no labels or quotes. Thank them before you start the summary. Do not use any separators like ---, --, -, ;, :, or similar or any markdown or formatting.`;
  const completion = await openai.chat.completions.create({
    model: MODELS.default,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Question: ${question}\n\n${roundTranscript}` },
    ],
    max_tokens: roundType === "poll" ? 60 : 200,
  });

  const text = (completion?.choices?.[0]?.message?.content ?? "").trim();
  return text || (roundType === "poll" ? "Thanks everyone for the quick answers!" : "Thanks everyone for sharing your views on that.");
}

/** Generic OpenAI boolean classification. Returns false on error. */
async function classifyWithOpenAI(sys, user, key) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.default,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 20,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return !!parsed[key];
  } catch (e) {
    console.error(`classifyWithOpenAI(${key}) error`, e?.message || e);
    return false;
  }
}

/** True if the participant's message indicates they don't know what passkey is and are asking for an explanation. */
async function isAskingWhatPasskeyIs(text, roundQuestion) {
  if (!text || !String(text).trim()) return false;
  const trimmed = String(text).trim();
  const sys = `You classify whether a chat message indicates the participant does NOT know what passkey is and is asking for an explanation. Return ONLY valid JSON: {"asksWhatPasskeyIs": true} or {"asksWhatPasskeyIs": false}. True when: asks what passkey is, expresses confusion, requests explanation. False when: already knows, sharing opinion.`;
  const user = `Round: ${String(roundQuestion ?? "").slice(0, 150)}\nMessage: "${trimmed.slice(0, 300)}"\nDoes this indicate they don't know passkey and want explanation?`;
  return classifyWithOpenAI(sys, user, "asksWhatPasskeyIs");
}

/**
 * Single call that classifies a participant's message two ways at once:
 *   isQuestion  — true if the message is a question to the moderator asking for
 *                 clarification/explanation rather than answering the prompt.
 *   substantive — true if the message substantively answers the prompt.
 * Returns { isQuestion: bool, substantive: bool }. Defaults to false on error.
 */
async function classifyHumanMessage(text, context, roundQuestion) {
  if (!text || !String(text).trim()) return { isQuestion: false, substantive: false, inappropriate: false };

  const wordCount = String(text).trim().split(/\s+/).filter(Boolean).length;
  // Hard word-count rules for substantiality — no API needed for these boundaries.
  // We still call the API to get isQuestion (short messages can still be questions).
  const forcedSubstantive = wordCount > 15 ? true : wordCount <= 3 ? false : null;

  const { type = "call_on", prompt = "" } = context || {};
  const sys = `You are a classifier. Given a participant's chat message, return ONLY valid JSON with exactly three boolean fields:
- "isQuestion": true if the message is primarily a question directed at the moderator asking for clarification or explanation (e.g. "what is X?", "can you explain?", "I don't understand X"), rather than sharing an answer/opinion/experience. False for filler ("ok","idk","sad"), emotions, statements, or anything that tries to answer the prompt.
- "substantive": true if the message substantively answers the prompt by sharing relevant content—experiences, opinions, or thoughts. False for filler, too vague, off-topic, or a question back to the moderator.
- "inappropriate": true if the message is clearly inappropriate — includes aggressive, hostile, or offensive language; sexual content; completely nonsensical gibberish (random characters/keyboard mashing); or content that is wildly and obviously off-topic with no connection to the discussion whatsoever. Normal short or vague answers are NOT inappropriate.
Note: if isQuestion is true, substantive should almost always be false. If inappropriate is true, both other fields should be false.
Return format: {"isQuestion": true/false, "substantive": true/false, "inappropriate": true/false}`;
  const user = `Prompt type: ${type}\nDiscussion question: "${String(roundQuestion ?? "").slice(0, 200)}"\nPrompt shown to participant: "${String(prompt || "").slice(0, 300)}"\nParticipant message: "${String(text).trim().slice(0, 400)}"`;
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.default,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 30,
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
  const fallback = [
    "Great question! I'm happy to clarify.",
    String(roundQuestion ?? "").slice(0, 100) + " — what do you think?",
  ];

  const previousCtx = alreadyAnswered.length > 0
    ? `\n\nPreviously answered questions this session:\n${alreadyAnswered
        .map((a, i) => `${i + 1}. Q: "${a.question.slice(0, 120)}" → A: "${a.answer.slice(0, 120)}"`)
        .join("\n")}`
    : "";

  const sys = `You are ${MODERATOR_NAME}, a warm and natural discussion moderator. A participant has asked a question.${previousCtx}

If the participant's question is asking about a topic you already answered above (same concept, even if worded differently), respond with ONLY a very brief reminder of 8 words or fewer — a single casual sentence (e.g. "A passkey replaces passwords — no typing needed!" or "I covered that just above!"). Return a JSON array with exactly 1 string.

Otherwise (new topic not yet covered), respond with EXACTLY a JSON array of 2 strings:
1. Answer the question naturally in at most 2 short sentences. Be casual and direct—no "as a moderator" preamble.
2. A single short sentence that gently rephrases the discussion question as a reminder and asks them to share their thoughts.
Return ONLY valid JSON array of 1 or 2 strings. No markdown, no extra text.`;

  const user = `Discussion question: "${String(roundQuestion ?? "").slice(0, 300)}"\nParticipant's question: "${String(questionText).trim().slice(0, 300)}"`;
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.default,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 160,
    });
    const raw = (completion?.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0]) {
      return [String(parsed[0]).trim()];
    }
    if (Array.isArray(parsed) && parsed.length >= 2 && parsed[0] && parsed[1]) {
      return [String(parsed[0]).trim(), String(parsed[1]).trim()];
    }
  } catch (e) {
    console.error("generateModeratorQuestionAnswer error", e?.message || e);
  }
  return fallback;
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
  const allRoundSegments = MODERATOR_SCRIPT.filter((s) => s.type === "big_question" || s.type === "poll");
  const allRounds = allRoundSegments.map((s) => ({ type: s.type, question: s.messages[0] }));
  const bigQuestions = allRounds.filter((r) => r.type === "big_question").map((r) => r.question);

  return {
    sessionId,
    moderatorName: MODERATOR_NAME,
    bots,
    participantName,
    humanDisplayName: capitalizeFirst(participantName),
    messages: [],
    scriptIndex: 0,
    waitingForHumanIntro: false,
    moderatorTypingIntroCue: false,
    userRepliedDuringIntroCue: false,
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
    bigQuestions,
    answeredQuestions: [], // { question, answer } pairs the moderator has already answered
    currentRoundIndex: -1,
    currentRoundType: allRounds[0]?.type || "big_question",
    pollState: null,
    usedRoundAckIndices: [],
    roundTranscript: [],  // Messages for current round; reset each new question
  };
}

function addMessage(session, name, text) {
  const m = { name, text: String(text).trim(), ts: Date.now() };
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

  function startHumanTurnForCallOn(name) {
    const co = session?.callOnState;
    if (!co) return;
    const nameForLog = name === session.participantName ? session.humanDisplayName : name;
    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=human ${nameForLog}, waiting for human_idle`);
    co.waitingForHumanIdle = true;
    co.humanRepliedThisTurn = false;
    session.humanGaveSubstantiveResponseThisTurn = false;
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

  const IDLE_CHECK_MS = 2000;

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
        const kickMsg = "I think you are not paying attention. I am kicking you out.";
        const m = addMessage(session, MODERATOR_NAME, kickMsg);
        logLine("MESSAGE", `[${MODERATOR_NAME}] "${kickMsg}"`);
        io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
        logLine("QUEUE", "idle kick: closing session after 2 nudges");
        await new Promise((r) => setTimeout(r, 1500));
        io.to(socket.id).emit("kicked", { reason: "idle", message: "You have been removed from the session." });
        session = null;
        return;
      }

      const nudgeMsg = `${session.humanDisplayName}, are you still there? Would you respond to this question?`;
      await emitModeratorLine(nudgeMsg, { cancelCheck: () => !!session?.humanIsTyping });
      if (session?.humanIsTyping) {
        // Nudge was cancelled mid-emission; undo the nudge count increment and reset timer
        session.idleNudgeCount = Math.max(0, (session.idleNudgeCount || 0) - 1);
        session.idleLastNudgeAt = null;
        session.idleLastActivityAt = Date.now();
        logLine("QUEUE", "idle nudge cancelled (user started typing)");
        return;
      }
      logLine("QUEUE", `idle nudge ${session.idleNudgeCount}/${MAX_NUDGES} sent`);
    }, IDLE_CHECK_MS);
  }

  /** Kick user for 4 unsubstantial messages in a row. Must be called inside human_message handler. */
  async function kickForUnsubstantial(sess) {
    clearIdleNudgeTimer();
    clearElaborationPromptTimer();
    const kickMsg = "Please provide more substantial responses. You have been removed from the session.";
    const m = addMessage(sess, MODERATOR_NAME, kickMsg);
    logLine("MESSAGE", `[${MODERATOR_NAME}] "${kickMsg}"`);
    io.to(socket.id).emit("message", { name: m.name, text: m.text, ts: m.ts });
    logLine("QUEUE", "unsubstantial kick: closing session after 4 unsubstantial in a row");
    await new Promise((r) => setTimeout(r, 1500));
    io.to(socket.id).emit("kicked", { reason: "unsubstantial", message: kickMsg });
    session = null;
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
    const { skipIfUserReplied: skipIfUserRepliedDuringCue, cancelCheck } = opts;
    if (!session) return;
    if (session.cancelAdvanceFromIdle || cancelCheck?.()) return;
    emitTyping(MODERATOR_NAME, true);
    await delay(THINKING_DELAY_MS);
    if (session?.cancelAdvanceFromIdle || cancelCheck?.()) {
      emitTyping(MODERATOR_NAME, false);
      return;
    }
    await delay(TYPING_DELAY_MS);
    if (!session) return;
    if (session.cancelAdvanceFromIdle || cancelCheck?.()) {
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
      // Commit to the ack + disagreement phase: clear pending-advance flags now so
      // user typing can no longer skip the ack or cancel the disagreement phase.
      session.pendingAdvanceFromIdle = false;
      session.cancelAdvanceFromIdle = false;
      logLine("QUEUE", "call-on round done, acknowledging then view-misalignment phase");
      await emitModeratorLine(pickRoundAckText(session));
      if (!session) return;
      runDisagreementPhase();
      return;
    }

    const nextName = co.order[co.currentIndex];
    const isHuman = isHumanTurn(session, nextName);
    const nameForCue = isHumanTurn(session, nextName) ? session.humanDisplayName : nextName;
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
      await emitModeratorLine(cue);
      if (fromHumanIdle && wasAdvanceCancelled(session)) {
        cancelAdvance(session, "advanceCallOn cancelled (user typing), waiting for human_idle again", "prev");
        return;
      }
      if (session) session.pendingAdvanceFromIdle = false;
      if (!session) return;
      startHumanTurnForCallOn(nextName);
      return;
    }

    const nextNameForLog = isHuman ? session.humanDisplayName : nextName;
    logLine("QUEUE", `call-on who_spoke=[${co.whoSpoke.join(", ")}] next=${nextNameForLog}`);
    await emitModeratorLine(cue);
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
   * a question to the moderator. If so, have Eunice answer (2 bubbles: answer +
   * re-ask of the round question) before the caller continues the flow.
   */
  async function checkAndAnswerBotQuestion(bubbles, roundQuestion) {
    if (!Array.isArray(bubbles) || bubbles.length === 0 || !session) return;
    const combined = bubbles.join(" ");
    let isQuestion = false;
    try {
      ({ isQuestion } = await classifyHumanMessage(
        combined,
        { type: "call_on", prompt: roundQuestion },
        roundQuestion
      ));
    } catch (e) {
      console.error("checkAndAnswerBotQuestion classify error", e?.message || e);
    }
    if (!isQuestion || !session) return;
    logLine("QUEUE", "bot asked a question, moderator answering");
    let answerBubbles;
    try {
      answerBubbles = await generateModeratorQuestionAnswer(combined, roundQuestion, session.answeredQuestions || []);
    } catch (e) {
      console.error("generateModeratorQuestionAnswer (bot) error", e?.message || e);
      return;
    }
    for (const bubble of answerBubbles) {
      if (!session) return;
      await emitModeratorLine(bubble);
    }
    if (session) {
      session.answeredQuestions = session.answeredQuestions || [];
      session.answeredQuestions.push({ question: combined, answer: answerBubbles[0] });
    }
  }

  async function runBotTurn(botName, directiveOverride) {
    if (!session?.callOnState) return;
    const co = session.callOnState;
    const humanDisplayName = session.humanDisplayName;
    const previousAnswers = co.whoSpoke.map((name) => {
      const msgName = name === session.participantName ? humanDisplayName : name;
      const msgs = session.messages.filter((m) => m.name === msgName);
      const text = msgs.map((m) => m.text).join(" ");
      return { name: msgName, text };
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
    await checkAndAnswerBotQuestion(bubbles, co.question);
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
    const resolve = (name) => {
      const n = String(name ?? "").trim().toLowerCase();
      const bot = botNames.find((b) => b.toLowerCase() === n);
      if (bot) return bot;
      if (participantName && participantName.toLowerCase() === n) return participantName;
      if (humanDisplayName && humanDisplayName.toLowerCase() === n) return participantName;
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
      // disagreedWith must be the one who spoke first; swap if LLM got order wrong
      if (orderIndex(a) > orderIndex(b)) [a, b] = [b, a];
      const disagreedWithResolved = a;
      const disagreedByResolved = b;
      const differenceSummary = String(p.differenceSummary ?? "").trim();
      // Use display names (humanDisplayName for human) everywhere: logs, prompts, transcripts
      const disagreedWithDisplay = a === participantName ? humanDisplayName : a;
      const disagreedByDisplay = b === participantName ? humanDisplayName : b;
      const disagreedByKey = b === participantName ? humanDisplayName : b;
      const disagreedByText = Array.isArray(answersByPerson[disagreedByKey])
        ? answersByPerson[disagreedByKey].join(" ")
        : (answersByPerson[disagreedByKey] ?? "");
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

    co.disagreementQueue = deduped;
    co.disagreementIndex = 0;
    if (deduped.length === 0) {
      logLine("QUEUE", "no view misalignments detected");
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
    await advanceToNextRound();
  }

  async function advanceToNextRound() {
    if (!session?.allRounds) return;
    const co = session.callOnState;
    if (wasAdvanceCancelled(session)) {
      cancelAdvance(session, "advanceToNextRound cancelled (user typing), waiting for human_idle again", "last");
      return;
    }
    const nextRoundIndex = (session.currentRoundIndex ?? -1) + 1;
    if (nextRoundIndex >= session.allRounds.length) {
      session.pendingAdvanceFromIdle = false;
      logLine("QUEUE", "all rounds done, wrapping up");
      await emitModeratorLine("Thanks everyone, that wraps up our discussion for today!");
      return;
    }
    const nextRound = session.allRounds[nextRoundIndex];
    logLine("QUEUE", `advancing to round ${nextRoundIndex + 1}/${session.allRounds.length} [${nextRound.type}]: "${clip(nextRound.question, 60)}"`);
    session.roundTranscript = [];
    await emitModeratorLine(nextRound.question);
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

    // big_question: rotate call-on order by 1, reset state, cue first speaker
    co.order = [...co.order.slice(1), co.order[0]];
    resetCallOnState(co, nextRound.question);

    const firstSpeaker = co.order[0];
    const nameForCue = isHumanTurn(session, firstSpeaker) ? session.humanDisplayName : firstSpeaker;
    let cue;
    try {
      cue = await generateModeratorCue(null, nameForCue, { isFirstInRound: true, bigQuestion: nextRound.question });
    } catch (e) {
      cue = `Let's start with ${nameForCue}.`;
    }
    await emitModeratorLine(cue);
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
      cue = await generateModeratorCue(latest, session.humanDisplayName, { isIntro: true });
    } catch (e) {
      cue = `How about you, ${session.humanDisplayName}?`;
    }
    if (!session) return;
    if (hasHumanRepliedAfterIntroPrompt(session)) {
      logLine("QUEUE", "intro: human already introduced while cue was being generated, advancing to study_goal");
      await runStudyGoal();
      return;
    }
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
    session.humanGaveSubstantiveResponseThisTurn = false;
    session.lastPromptForHuman = { type: "intro", prompt: "Please introduce yourself—share your name and anything you feel like mentioning." };
    startIdleNudgeTimer();
    logLine("QUEUE", `waiting for human intro from ${session.humanDisplayName}`);
  }

  /** Study goal: moderator messages, then 1 ack (one random bot). */
  async function runStudyGoal() {
    if (!session) return;
    const segment = MODERATOR_SCRIPT.find((s) => s.type === "study_goal");
    if (!segment?.messages?.length) {
      startFirstRound();
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

    logLine("QUEUE", "study_goal ack done, starting first round");
    startFirstRound();
  }

  /** Start first round (big_question or poll): set state, emit moderator question, then first speaker. */
  async function startFirstRound() {
    if (!session) return;
    const firstRound = session.allRounds?.[0];
    if (!firstRound) return;
    session.currentRoundIndex = 0;
    session.currentRoundType = firstRound.type;
    session.waitingForHumanIntro = false;
    session.roundTranscript = [];
    logLine("QUEUE", `first round [${firstRound.type}]: "${clip(firstRound.question, 60)}"`);
    await emitModeratorLine(firstRound.question);
    if (!session) return;

    if (firstRound.type === "poll") {
      await runPollRound(firstRound.question);
      return;
    }

    // big_question
    const co = session.callOnState;
    resetCallOnState(co, firstRound.question);
    const firstSpeaker = co.order[0];
    const nameForCue = isHumanTurn(session, firstSpeaker) ? session.humanDisplayName : firstSpeaker;
    let cue;
    try {
      cue = await generateModeratorCue(null, nameForCue, { isFirstInRound: true, bigQuestion: firstRound.question });
    } catch (e) {
      cue = `Let's start with ${nameForCue}.`;
    }
    await emitModeratorLine(cue);
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
    session.pollState = {
      question,
      botsFinished: false,
      humanFinished: false,
      answers: {},
    };

    // All bots respond in parallel with 1–4 s random think delay + typing delay
    const botPromises = session.bots.map((bot) => {
      const thinkMs = randomBetween(1000, 4000);
      return new Promise(async (resolve) => {
        await delay(thinkMs);
        if (!session) { resolve(); return; }
        emitTyping(bot, true);
        await delay(TYPING_DELAY_MS);
        if (!session) { resolve(); return; }
        emitTyping(bot, false);
        let bubbles = [];
        try {
          bubbles = await getBotResponse(bot, {
            moderatorQuestion: question,
            directive: null,
            previousAnswers: [],
            session,
            bots: session.bots,
            roundType: "poll",
          });
          logLine("OPENAI_OK", `poll bot=${bot} ans="${clip(JSON.stringify(bubbles), 80)}"`);
        } catch (e) {
          logLine("OPENAI_ERR", `poll bot=${bot} ${e?.message || e}`);
          bubbles = ["Not sure."];
        }
        if (!session) { resolve(); return; }
        const answer = bubbles[0] || "Not sure.";
        emitMessage(bot, answer);
        if (session.pollState) session.pollState.answers[bot] = answer;
        resolve();
      });
    });

    // Set up human waiting state (same idle/nudge mechanism as intro/call-on)
    const co = session.callOnState;
    co.question = question;
    co.waitingForHumanIdle = true;
    co.humanRepliedThisTurn = false;
    session.humanGaveSubstantiveResponseThisTurn = false;
    session.lastPromptForHuman = { type: "poll", prompt: question };
    startIdleNudgeTimer();

    // Wait for all bots (they run concurrently with human's response)
    await Promise.all(botPromises);
    if (!session) return;

    session.pollState.botsFinished = true;
    logLine("QUEUE", `poll: all bots answered. humanFinished=${session.pollState.humanFinished}`);

    // If human already went idle after replying, finish now; otherwise wait for human_idle event
    if (session.pollState.humanFinished) {
      await finishPollRound();
    }
  }

  async function finishPollRound() {
    if (!session?.pollState) return;
    const { question, answers } = session.pollState;

    // Include human's answer(s) in the summary
    const humanDisplayName = session.humanDisplayName;
    const humanMsgs = (session.roundTranscript || [])
      .filter((m) => m.name === humanDisplayName)
      .map((m) => m.text);
    if (humanMsgs.length) answers[humanDisplayName] = humanMsgs.join(" ");

    const transcriptStr = Object.entries(answers).map(([name, text]) => `${name}: ${text}`).join("\n");
    let summary;
    try {
      summary = await generateRoundSummary(question, transcriptStr, { roundType: "poll" });
    } catch (e) {
      summary = "Thanks everyone for the quick answers!";
    }
    if (!session) return;
    await emitModeratorLine(summary);
    if (!session) return;
    session.pollState = null;
    await advanceToNextRound();
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
    await emitModeratorLine(followUpText);
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
      session.lastPromptForHuman = { type: "disagreement", prompt: followUpText };
      startIdleNudgeTimer();
      logLine("QUEUE", `view-misalignment follow-up: waiting for human ${session.humanDisplayName} to respond (${item.differenceSummary})`);
      return;
    }

    const humanDisp = session.humanDisplayName;
    const previousAnswers = session.messages
      .filter((m) => co.order.includes(m.name) || m.name === humanDisp)
      .map((m) => ({ name: m.name, text: m.text }));
    const context = {
      moderatorQuestion: co.question,
      directive: followUpText,
      previousAnswers,
      session,
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
    await checkAndAnswerBotQuestion(bubbles, co.question);
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

  function clearElaborationPromptTimer() {
    if (session?.elaborationPromptTimer) {
      clearTimeout(session.elaborationPromptTimer);
      session.elaborationPromptTimer = null;
    }
    if (session) session.elaborationPromptCancelled = true;
  }

  socket.on("human_typing", ({ isTyping, hasDraft } = {}) => {
    if (isTyping !== undefined) logLine("TYPING", `human ${isTyping}`);
    if (session && isTyping !== undefined) session.humanIsTyping = !!isTyping;
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
          await kickForUnsubstantial(session);
          return;
        }
        session.substantialNudgeCount = nudgeCount;
        await emitModeratorLine("Could you elaborate? Please share your thoughts on the question.", {
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
      clearIdleNudgeTimer();
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
    // Poll round: mark human done, then finish if bots are also done
    if (session.currentRoundType === "poll") {
      clearIdleNudgeTimer();
      logLine("QUEUE", `human_idle after poll answer from ${session.humanDisplayName}`);
      co.waitingForHumanIdle = false;
      if (session.pollState) {
        session.pollState.humanFinished = true;
        if (session.pollState.botsFinished) {
          await finishPollRound();
        }
        // else: wait; finishPollRound will be triggered after botPromises resolve
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
    }
    if (session && isWaitingForHuman(session)) {
      session.idleLastActivityAt = Date.now();
      session.idleUserHasTyped = true;
      session.idleNudgeCount = 0;
      session.idleLastNudgeAt = null;
    }
    logLine("HUMAN_INPUT", `[${session.humanDisplayName}] "${clip(text, 160)}"`);

    // If intro, extract introduced name before emitting so message/transcript use it
    if (session.waitingForHumanIntro || session.moderatorTypingIntroCue) {
      const introduced = extractIntroducedName(text);
      if (introduced && introduced.toLowerCase() !== session.participantName.trim().toLowerCase()) {
        session.introducedName = capitalizeFirst(introduced.trim());
        session.humanDisplayName = session.introducedName;
        logLine("QUEUE", `intro: using introduced name "${session.humanDisplayName}" (NamePage had "${session.participantName}")`);
        io.to(socket.id).emit("introduced_name", { name: session.humanDisplayName });
      }
    }

    emitMessage(session.humanDisplayName, text); // show immediately; validate below

    // Validate response before advancing: treat non-substantive replies as if user never responded.
    // Once the user has given at least one substantive response this turn, skip further checks and just wait for idle to advance.
    const inIntroPhase = session.waitingForHumanIntro || session.moderatorTypingIntroCue;
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

    // Always run full classification on every message.
    // inappropriate is checked for all messages; isQuestion/substantive only used when prompted.
    const { isQuestion: isModQuestion, substantive, inappropriate } = await classifyHumanMessage(
      text, ctx || { type: "call_on", prompt: "" }, roundQuestion
    );
    logLine("HUMAN", `classify: inappropriate=${inappropriate} isQuestion=${isModQuestion} substantive=${substantive}`);

    if (inappropriate) {
      clearIdleNudgeTimer();
      clearElaborationPromptTimer();
      logLine("QUEUE", "human_message: inappropriate content detected, kicking user");
      await new Promise((r) => setTimeout(r, 1000));
      if (session) io.to(socket.id).emit("kicked", { reason: "inappropriate", message: "You have been removed by the moderator." });
      session = null;
      return;
    }

    if (needResponseCheck) {
      if (isModQuestion) {
        // Participant asked the moderator a question instead of answering the prompt.
        // Have Eunice answer it (2 bubbles) and re-ask the question; keep waiting.
        logLine("QUEUE", "human_message: question for moderator detected, generating answer");
        let bubbles;
        try {
          bubbles = await generateModeratorQuestionAnswer(text, roundQuestion, session.answeredQuestions || []);
        } catch (e) {
          console.error("generateModeratorQuestionAnswer error", e?.message || e);
          bubbles = ["Happy to clarify!", `So — ${roundQuestion.slice(0, 80)}?`];
        }
        if (session) {
          session.answeredQuestions = session.answeredQuestions || [];
          session.answeredQuestions.push({ question: text, answer: bubbles[0] });
        }
        for (const bubble of bubbles) {
          if (!session) return;
          await emitModeratorLine(bubble);
        }
        if (!session) return;
        // Refresh the idle nudge timer so user has full time to answer.
        if (isWaitingForHuman(session)) startIdleNudgeTimer();
        logLine("QUEUE", "human_message: moderator answered question, waiting for user to respond to the prompt");
        return;
      }

      if (!isPollRound) {
        if (!substantive) {
          session.waitingForElaborationAfterNonSubstantive = true;
          logLine("QUEUE", "human_message: response not substantive, waiting for idle then 5s before elaborate");
          return;
        }
        session.substantialNudgeCount = 0; // reset: user gave a substantive response
        session.waitingForElaborationAfterNonSubstantive = false;
        session.humanGaveSubstantiveResponseThisTurn = true;
        logLine("HUMAN", "human_message: response is substantive, advancing");
      }
    }

    const repliedWhileModeratorTypingIntroCue = !!session.moderatorTypingIntroCue;
    if (repliedWhileModeratorTypingIntroCue) {
      session.userRepliedDuringIntroCue = true;
      session.moderatorTypingIntroCue = false;
    }
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
      logLine("QUEUE", `human_message during call-on: ${session.humanDisplayName} replied, waiting for idle to advance`);
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
    clearIdleNudgeTimer();
    clearElaborationPromptTimer();
    if (session) {
      logLine("DISCONNECT", `id=${socket.id}`);
    }
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
