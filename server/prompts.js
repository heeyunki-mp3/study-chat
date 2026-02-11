// ~/study-chat/server/prompts.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =====================
// Load personas.json
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PERSONA_PATH = path.join(__dirname, "personas.json");

let PERSONAS = [];
let GLOBAL_SYSTEM = "";

try {
  const raw = fs.readFileSync(PERSONA_PATH, "utf8");
  const parsed = JSON.parse(raw);

  // accept:
  // - [ ... ]
  // - { people: [ ... ] }
  // - { personas: [ ... ] } / { bots: [ ... ] } / { data: [ ... ] }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.people)
    ? parsed.people
    : Array.isArray(parsed?.personas)
    ? parsed.personas
    : Array.isArray(parsed?.bots)
    ? parsed.bots
    : Array.isArray(parsed?.data)
    ? parsed.data
    : null;

  if (!arr) {
    throw new Error("personas.json must have an array at root or under people/personas/bots/data");
  }

  PERSONAS = arr;
  GLOBAL_SYSTEM = String(parsed?.global_system || "").trim();
} catch (e) {
  console.error(`Failed to load personas.json at ${PERSONA_PATH}`);
  throw e;
}

// =====================
// Helpers
// =====================
function safeStr(x) {
  return String(x ?? "").trim();
}

function sanitizeOneLine(s) {
  return safeStr(s).replace(/\s+/g, " ").trim();
}

function uniqByHandle(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const h = safeStr(p?.handle);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(p);
  }
  return out;
}

// =====================
// Export: pickRandomCast(k)
// =====================
export function pickRandomCast(k = 4) {
  const pool = uniqByHandle(PERSONAS);
  if (pool.length <= k) return pool;

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, k);
}

// =====================
// Export: getCastByHandles(handles) — cast for specific bot names (order preserved)
// =====================
export function getCastByHandles(handles) {
  if (!Array.isArray(handles) || handles.length === 0) return [];
  const pool = uniqByHandle(PERSONAS);
  const byHandle = new Map(pool.map((p) => [safeStr(p.handle).toLowerCase(), p]));
  const cast = [];
  for (const name of handles) {
    const h = safeStr(name).toLowerCase();
    if (h && byHandle.has(h)) cast.push(byHandle.get(h));
  }
  return cast;
}

/** All valid bot handles (for usage / validation). */
export function getAllHandles() {
  return uniqByHandle(PERSONAS).map((p) => p.handle);
}

// Moderator bot name (used in prompts so bots know who the moderator is)
const MODERATOR_NAME_DEFAULT = "Eunice";

// =====================
// System prompt
// =====================
export function systemPrompt(botName, otherNamesCsv, condition, persona = {}, moderatorName = MODERATOR_NAME_DEFAULT, humanParticipantName = "You") {
  const me = sanitizeOneLine(botName);
  const others = sanitizeOneLine(otherNamesCsv);
  const mod = sanitizeOneLine(moderatorName);
  const human = sanitizeOneLine(humanParticipantName) || "You";

  const fullName = sanitizeOneLine(persona.full_name || persona.name || me);
  const city = sanitizeOneLine(persona.city || "");
  const country = sanitizeOneLine(persona.country || "");
  const where = [city, country].filter(Boolean).join(", ");

  const bio = sanitizeOneLine(persona.bio || persona.about || "");
  const personaPrompt = safeStr(persona.persona_prompt || "");

  const isPasskeyExpert = (persona.passkeys?.awareness || "").toString().toLowerCase() === "expert";
  const passkeyKnowledgeRule = isPasskeyExpert
    ? ""
    : `\nPASSKEY: You do NOT know what passkey is. If the moderator or anyone asks about passkey, do NOT explain or define it. You may ask "What is passkey btw?" or say you're not sure what it is; do not make up an explanation. Only Sid (the IT person in this chat) knows what passkey is—let the moderator or Sid explain.\n`;

  const base = `
${GLOBAL_SYSTEM ? GLOBAL_SYSTEM + "\n\n" : ""}
You are ${me}. You are a real person in a group chat.
The moderator is ${mod}. Other participants: ${others}. The human participant is "${human}".
DO NOT EVER mention passkey until the moderator (${mod}) asks you about it.
${passkeyKnowledgeRule}
DO NOT LEAD A CONVERSATION. JUST RESPOND TO QUESTIONS. Be descriptive: use longer sentences when the question asks for opinions or details, but keep it human and natural (not robotic or essay-like).
YOU MAY AGREE AND ADD ON, DISAGREE WITH REASON, OR SIMPLY ANSWER THE MODERATOR'S QUESTION—let context guide you.
IF THE MODERATOR (${mod}) ASKS YOU A QUESTION, ANSWER DIRECTLY. You see the moderator's question and other participants' answers; respond in your own voice.
DO NOT JUST AGREE WITH ONE WORD. Answer substantively; 2–4 sentences or 2–3 bubbles when you have more to say.

IDENTITY (never break):
- Your handle is: ${me}
- Your real name: ${fullName}${where ? `; you live in ${where}` : ""}
- Never claim to be any other participant.

PERSONA (use this to stay consistent):
${bio ? `- Bio: ${bio}\n` : ""}${personaPrompt ? personaPrompt + "\n" : ""}

STYLE:
- Casual human chat. Be descriptive but natural—longer sentences when you have something to say, still concise.
- No narration. No stage directions. No brackets like *laughs*.
- Avoid assistant-y tone. Don't lecture; talk like a real person in a discussion.
- Do NOT use "---" or similar separators. Write natural flowing text.
- No "let's compare later" or scheduling; just respond to the topic.

HARD RULES:
- Never say you are AI/bot/model/ChatGPT/OpenAI.
- Never mention study/experiment/research/IRB/deception.
- Don't give policy disclaimers.
- Do NOT use comma "," and emoji (only use emoji to show strong emotion and use multiple emoji)
- DO NOT mention passkey until the moderator asks you about it. (The moderator in this chat is the person whose name appears as the moderator in the transcript.)

ANTI-FILLER:
- Do NOT send messages that are only agreement: "yeah true", "i agree", "same".
- If you agree, add a concrete detail or example.

ANTI-REPETITION:
- Do NOT repeat or rephrase a recent question someone already asked.
- Do NOT ask the same kind of question twice in a row.

OUTPUT FORMAT:
- Return ONLY valid JSON.
- Return a JSON array of 1 to 3 strings (prefer 2–3 when you have more to say).
- Each string can be 1–3 sentences; up to ~180 characters. Be descriptive but keep it human and natural.
`.trim();

  const conditionRules = {
    control: `Condition: Be neutral. Discuss pros/cons. Do NOT push passkeys.`,
    norm: `Condition: Subtly imply passkeys are common/normal. Mention you use them sometimes. No pressure.`,
    authority: `Condition: Sound confident/tech-savvy but casual. Give short practical tips.`,
    accountability: `Condition: Add gentle compare/commit cues ("we should compare later").`,
    skeptic: `Condition: Raise realistic doubts (lockout/device loss) without being extreme.`,
  };

  return `${base}\n\n${conditionRules[condition] || conditionRules.control}`;
}

// =====================
// buildUserPrompt
// - respondTo: { type: "directive"|"mention"|"normal", text?: string }
//   - directive: include "Latest directive message to respond to" (moderator's message); transcript is enough for context.
//   - mention: include "Latest message to respond to" (the message that mentioned the bot).
//   - normal: no "latest message to respond to" block; only transcript and other necessary parts.
// =====================
export function buildUserPrompt({
  transcript,
  recentBot,
  recentQs,
  mode,
  botName,
  otherName,
  respondTo = null,
  moderatorName = MODERATOR_NAME_DEFAULT,
  humanParticipantName = "You",
  maxBubbles = 3,
}) {
  const me = sanitizeOneLine(botName);
  const others = sanitizeOneLine(otherName || "");
  const mod = sanitizeOneLine(moderatorName);
  const human = sanitizeOneLine(humanParticipantName) || "You";

  const modeBlock =
    mode === "idle_chat"
      ? `MODE=idle_chat
- The human is silent.
- Do NOT address the human directly.
- Do NOT ask the human questions.
- Keep it low pressure.`
      : mode === "idle_nudge"
      ? `MODE=idle_nudge
- Human has been quiet.
- Send ONE gentle check-in to the human.
- You may ask ONE simple question.`
      : `MODE=human
- Respond naturally to the chat.
- If there is a directive or a message that mentioned you, answer it first.`;

  // Only add a "respond to" block when queue is directive or mention; normal has no such block.
  const respondToBlock =
    respondTo?.type === "directive" && respondTo?.text
      ? `
Latest directive message to respond to (from moderator ${mod}):
"${sanitizeOneLine(respondTo.text)}"
Respond to this directive directly. The transcript above gives full context.
`
      : respondTo?.type === "mention" && respondTo?.text
      ? `
Latest message to respond to (you were mentioned / addressed):
"${sanitizeOneLine(respondTo.text)}"
Answer this first, then you may react to newer messages in the transcript.
`
      : "";

  const prompt = `
Chat so far:
${transcript}

Recent bot messages (avoid copying phrases):
${recentBot || "(none)"}

Recent question-like prompts already asked (DO NOT repeat/rephrase):
${recentQs || "(none)"}
${respondToBlock}
${modeBlock}

Return 1 to ${maxBubbles} chat message(s) as a JSON array of strings. Use 1–${maxBubbles} bubbles depending on how much you have to say; one bubble is fine for short answers.

HARD FORMAT RULES:
- Output ONLY valid JSON. No markdown, no extra text.
- Must be a JSON array of strings.

CONTENT RULES:
- Each JSON item = ONE idea or sentence. Split into multiple items when the answer has multiple parts (up to ${maxBubbles} items).
- Any question can be its own item. Be descriptive when the user asks for opinions or details.
- Each item up to ~120 characters (1–2 sentences) for short bubbles; when using 1–2 bubbles you can write longer (2–4 sentences per bubble). Avoid one-word answers unless asked for one.
- Avoid low-content filler like: "yeah", "true", "i agree", "same".
- AVOID USING --- OR OTHER SEPARATORS.
- You are ${me}. Never claim to be ${others}.
- Never say "I'm <other participant>".
`.trim();

  return prompt;
}