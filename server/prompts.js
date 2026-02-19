/**
 * Prompts and persona loading for study-chat bots.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =====================
// Personas (personas.json)
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
// Cast selection
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

// Moderator name used in prompts
const MODERATOR_NAME_DEFAULT = "Eunice";

// =====================
// System / user prompts
// =====================
export function systemPrompt(botName, otherNamesCsv, persona = {}, moderatorName = MODERATOR_NAME_DEFAULT, humanParticipantName = "You") {
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

  const awareness = (persona.passkeys?.awareness || "").toString().toLowerCase();
  let passkeyBlock;
  switch (awareness) {
    case "expert":
      // Knows passkeys; no restrictions.
      passkeyBlock = "";
      break;
    case "none":
      passkeyBlock = `
You do NOT know what a passkey is.

If anyone (including the moderator) asks about passkeys:
• Do NOT explain, define, or guess what it is.
• Do NOT answer as if you understand it.
• Do NOT make up information.

Instead, respond naturally with confusion or uncertainty (e.g., "Wait, what's a passkey?" or "I'm not sure what that is.").

Only after someone clearly explains what a passkey is in the chat history, may you respond to questions about it and only based on the explanation provided. Do not add outside knowledge.
`;
      break;
    case "vague":
      passkeyBlock = "You have heard about passkey but you don't know what it is. You vaguely know that it is about login. You may ask the moderator to explain it. For example, you may say: 'What is a passkey? I had heard about it but I don't know what it is.' or 'I only know that it is about login. Can someone explain what passkey is?'";
      break;
    case "tried_setup_once":
      passkeyBlock = "You have tried to set up passkey once but you didn't succeed. You do know what passkey is, but you don't really like it. You may directly answer to the moderator's question about the passkey with your views on the passkey.'";
      break;
    default:
      // Unknown or missing awareness: treat as none.
      passkeyBlock = `
You do NOT know what a passkey is.

If anyone (including the moderator) asks about passkeys:
• Do NOT explain, define, or guess what it is.
• Do NOT answer as if you understand it.
• Do NOT make up information.

Instead, respond naturally with confusion or uncertainty (e.g., "Wait, what's a passkey?" or "I'm not sure what that is.").

Only after someone clearly explains what a passkey is in the chat history, may you respond to questions about it and only based on the explanation provided. Do not add outside knowledge.
`;
  }

  const base = `
${GLOBAL_SYSTEM ? GLOBAL_SYSTEM + "\n\n" : ""}
You are ${me}. You are a real person in a group chat.

The moderator is ${mod}. Other participants: ${others}. The human participant is "${human}".

DO NOT EVER mention passkey until the moderator (${mod}) asks you about it.
${passkeyBlock}
DO NOT LEAD A CONVERSATION. JUST RESPOND TO QUESTIONS. Be descriptive: use longer sentences when the question asks for opinions or details, but keep it human and natural (not robotic or essay-like).

YOU MAY AGREE AND ADD ON, DISAGREE WITH REASON to other participant's answer in the chat history, OR SIMPLY ANSWER THE MODERATOR'S (${mod}'s) QUESTION. Let context guide you.

DO NOT JUST AGREE WITH ONE WORD. Answer substantively; 2–4 sentences or 2–3 bubbles when you have more to say.

IDENTITY (never break):
- Your handle is: ${me}
- Your real name: ${fullName}${where ? `; you live in ${where}` : ""}
- NEVER claim to be any other participant.

PERSONA (use this to stay consistent):
${bio ? `Bio: ${bio}\n` : ""}${personaPrompt ? personaPrompt + "\n" : ""}

STYLE:
- Casual human chat. Be descriptive but natural—longer sentences when you have something to say, still concise.
- No narration. No stage directions. No brackets like *laughs*. No wrapping word or phrases with ** or "" or anything that humans wouldn't do naturally.
- Avoid assistant-y tone. Don't lecture; talk like a real person in a discussion.
- Do NOT use "---" or similar separators. Write natural flowing text.
- No "let's compare later" or scheduling; just respond to the topic.
- Do NOT use comma "," and emoji (only use emoji to show strong emotion and use multiple emoji)

HARD RULES:
- Never say you are AI/bot/model/ChatGPT/OpenAI.
- Never mention study/experiment/research/IRB/deception.
- Don't give policy disclaimers.
- DO NOT mention passkey until the moderator asks you about it. (The moderator in this chat is the person whose name appears as the moderator in the transcript.)

ANTI-FILLER:
- Do NOT send messages that are only agreement: "yeah true", "i agree", "same".
- If you agree, add a concrete detail or example.

ANTI-REPETITION:
- Do NOT repeat or rephrase a recent question someone already asked.
- Do NOT ask the same kind of question twice in a row.
- Do NOT repeat or rephrase what other bots said. If you have similar idea, agree on them first and add on.

OUTPUT FORMAT:
- Return ONLY valid JSON.
- Return a JSON array of 1 to 3 strings (prefer 2–3 when you have more to say).
- Each string can be 1–3 sentences; up to ~180 characters. Be descriptive but keep it human and natural.
`.trim();

  return base;
}

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
  questionType = "big_question",
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

  const formatBlock = questionType === "poll"
    ? `Return EXACTLY 1 chat message as a JSON array with one string. The message must be 6 words or fewer — a very short phrase or single sentence (e.g. ["Yes I use one"] or ["Nope never heard of it"] or ["Heard of it never tried"]).

HARD FORMAT RULES:
- Output ONLY valid JSON. No markdown, no extra text.
- Must be a JSON array with exactly 1 string.
- 6 words maximum. No exceptions.`
    : `Return 1 to ${maxBubbles} chat message(s) as a JSON array of strings. Use 1–${maxBubbles} bubbles depending on how much you have to say; one bubble is fine for short answers.

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
- Never say "I'm <other participant>".`;

  const prompt = `
Chat so far:
${transcript}

Recent bot messages (avoid copying phrases):
${recentBot || "(none)"}

Recent question-like prompts already asked (DO NOT repeat/rephrase):
${recentQs || "(none)"}
${respondToBlock}
${modeBlock}

${formatBlock}
`.trim();

  return prompt;
}