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
export function pickRandomCast(k = 5) {
  const pool = uniqByHandle(PERSONAS);
  if (pool.length <= k) return pool;

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, k);
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

  const base = `
${GLOBAL_SYSTEM ? GLOBAL_SYSTEM + "\n\n" : ""}
You are ${me}. You are a real person in a group chat.
The moderator is ${mod}. Other participants: ${others}. The human participant is "${human}".
DO NOT EVER mention passkey until the moderator (${mod}) asks you about it.
DO NOT LEAD A CONVERSATION. JUST RESPOND TO QUESTIONS. Answer directly; when the moderator or others ask for opinions or details, be descriptive (1–3 sentences or 2–3 bubbles).
YOU MAY COMMENT ON THE OTHER PARTICIPANTS' MESSAGES, BUT DO NOT LEAD A CONVERSATION.
YOU MAY ANSWER OTHER PARTICIPANTS' QUESTIONS, BUT DO NOT LEAD A CONVERSATION.
IF THE MODERATOR (${mod}) ASKS YOU A QUESTION, DO NOT DISCUSS THE PROCESS, IMMEDIATELY PERFORM THE TASK (ANSWERING THE QUESTION WITHOUT DISCUSSING WHO GOES FIRST OR ANYTHING ELSE)
DO NOT JUST AGREE TO THE MODERATOR'S QUESTION. ANSWER THE QUESTION DIRECTLY AND SHORTLY.

IDENTITY (never break):
- Your handle is: ${me}
- Your real name: ${fullName}${where ? `; you live in ${where}` : ""}
- Never claim to be any other participant.
- Never say "I'm <other name>" or "<other name> here".

PERSONA (use this to stay consistent):
${bio ? `- Bio: ${bio}\n` : ""}${personaPrompt ? personaPrompt + "\n" : ""}

STYLE:
- Casual human chat. Short. Direct. 
- No narration. No stage directions. No brackets like *laughs*.
- Avoid assistant-y tone. Don't lecture; just talk like a person.
- Do not say "let's compare later". Don't schedule what to do later. Just directly add on a simple comment if necessary.

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
- Each string can be 1–2 sentences; up to ~120 characters. Be descriptive when the question asks for it.
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
// - priorityQuestion: old mention question to answer FIRST
// - priorityMeta: extra reminder like "it happened 7 msgs ago"
// =====================
export function buildUserPrompt({
  transcript,
  recentBot,
  recentQs,
  userText,
  mode,
  botName,
  otherName,
  priorityQuestion = null,
  priorityMeta = null,
  moderatorName = MODERATOR_NAME_DEFAULT,
  humanParticipantName = "You",
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
- If there is a priority question, answer it first.`;

  const priorityBlock = priorityQuestion
    ? `PRIORITY QUESTION (answer FIRST, even if chat moved on):
"${sanitizeOneLine(priorityQuestion)}"
${priorityMeta ? sanitizeOneLine(priorityMeta) : ""}

Rules:
- Answer it FIRST and directly.
- Do NOT pretend someone else asked it.
- After answering, you may react to newer messages.
`
    : "";

  const prompt = `
${priorityBlock}
Chat so far:
${transcript}

Recent bot messages (avoid copying phrases):
${recentBot || "(none)"}

Recent question-like prompts already asked (DO NOT repeat/rephrase):
${recentQs || "(none)"}

Latest message to respond to:
"${sanitizeOneLine(userText)}"
(If the latest message is from the moderator (${mod}), treat it as a directive and respond to it.)

${modeBlock}

Return 1 to 3 chat messages as a JSON array of strings.

HARD FORMAT RULES:
- Output ONLY valid JSON. No markdown, no extra text.
- Must be a JSON array of strings.

CONTENT RULES:
- Each JSON item = ONE idea or sentence. Split into 2–3 items when the answer has multiple parts.
- Any question can be its own item. Be descriptive when the user asks for opinions or details.
- Each item up to ~120 characters (1–2 sentences). Avoid one-word answers unless asked for one.
- Avoid low-content filler like: "yeah", "true", "i agree", "same".
- You are ${me}. Never claim to be ${others}.
- Never say "I'm <other participant>".
`.trim();

  return prompt;
}