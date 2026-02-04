#!/usr/bin/env node
/**
 * CLI to interact with a fine-tuned (or default) bot model.
 * Uses the same prompts and model lookup as the server.
 *
 * Usage:
 *   node scripts/chat_finetune_cli.js [botName]
 *   node scripts/chat_finetune_cli.js Sid
 *   node scripts/chat_finetune_cli.js Mina --condition control
 *
 * Requires: OPENAI_API_KEY (e.g. in .env)
 */
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import readline from "readline";
import OpenAI from "openai";
import { systemPrompt, buildUserPrompt } from "../prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey?.trim()) {
  console.error("Set OPENAI_API_KEY (e.g. in .env)");
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

// Load models.json (same as server)
let MODELS = { default: "gpt-4.1-mini", bots: {} };
try {
  const raw = fs.readFileSync(path.join(SERVER_DIR, "models.json"), "utf8");
  MODELS = JSON.parse(raw);
  if (!MODELS.bots) MODELS.bots = {};
} catch (e) {
  console.warn("Could not load models.json, using default model only");
}

function getModelForBot(botName) {
  const id = MODELS.bots[botName];
  // Placeholder IDs (e.g. ft:...:ORG:MINA_MODEL_ID) mean "not trained yet" → use default
  if (!id || String(id).includes("_MODEL_ID")) return MODELS.default;
  return id;
}

// Load personas by handle (for systemPrompt)
function loadPersonasByHandle() {
  const raw = fs.readFileSync(path.join(SERVER_DIR, "personas.json"), "utf8");
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed?.people ?? parsed?.personas ?? parsed?.bots ?? parsed?.data ?? null;
  if (!arr) return {};
  const byHandle = {};
  for (const p of arr) {
    const h = String(p?.handle ?? "").trim();
    if (h) byHandle[h] = p;
  }
  return byHandle;
}

function buildTranscript(history, maxTurns = 30) {
  return history
    .slice(-maxTurns)
    .map((m) => `${m.name}: ${m.text}`)
    .join("\n");
}

function ensureString(x) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "object" && !Array.isArray(x)) {
    const t = x.content ?? x.text ?? x.message ?? x.value;
    if (t != null && typeof t === "string") return t.trim();
    return "";
  }
  return String(x).trim();
}

function parseJsonArray(rawText, maxItems = 3) {
  if (!rawText) return [];
  let s = String(rawText).trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  function tryParse(str) {
    try {
      const parsed = JSON.parse(str);
      if (!Array.isArray(parsed)) return null;
      return parsed.map((x) => ensureString(x)).filter(Boolean).map((x) => x.slice(0, 220)).slice(0, maxItems);
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
  return s ? [s.slice(0, 220)] : [];
}

async function getReply(botName, history, condition, personasByHandle) {
  const allHandles = Object.keys(personasByHandle);
  const others = allHandles.filter((n) => n !== botName).join(", ") || "others";
  const persona = personasByHandle[botName] || {};
  const moderatorName = "Eunice";
  const sys = systemPrompt(botName, others, condition, persona, moderatorName);
  const transcript = buildTranscript(history, 30);
  const lastText = history.slice(-1)[0]?.text ?? "";
  const userPrompt = buildUserPrompt({
    transcript,
    recentBot: "",
    recentQs: "",
    userText: lastText,
    mode: "human",
    botName,
    otherName: others,
    priorityQuestion: null,
    priorityMeta: null,
    moderatorName,
  });

  const model = getModelForBot(botName);
  const resp = await openai.responses.create({
    model,
    input: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
  });
  const raw = (resp.output_text || "").trim();
  return parseJsonArray(raw, 3);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: node scripts/chat_finetune_cli.js [botName] [--condition CONDITION]
        npm run chat:ft [-- Sid]
        npm run chat:ft -- Mina --condition control

  botName    Bot to chat with (default: Sid). Use a handle from personas.json.
  --condition  control | norm | authority | accountability | skeptic (default: control)

Requires OPENAI_API_KEY (e.g. in .env). Uses models.json for fine-tuned model IDs.
`);
    process.exit(0);
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  let botName = positional[0] || "Sid";
  let condition = "control";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--condition" && args[i + 1]) condition = args[i + 1];
  }

  const personasByHandle = loadPersonasByHandle();
  if (!personasByHandle[botName]) {
    console.error(`Unknown bot "${botName}". Available: ${Object.keys(personasByHandle).join(", ")}`);
    process.exit(1);
  }

  const model = getModelForBot(botName);
  const isFineTuned = (MODELS.bots[botName] ?? null) != null;

  console.log(`Bot: ${botName}  |  Model: ${isFineTuned ? model : model + " (default)"}`);
  console.log(`Condition: ${condition}`);
  console.log("Type a message and press Enter. Empty line or Ctrl+C to exit.\n");

  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function prompt() {
    rl.question("You: ", async (line) => {
      const text = (line || "").trim();
      if (!text) {
        rl.close();
        return;
      }
      history.push({ name: "You", text });
      process.stdout.write(`${botName}: `);
      try {
        const bubbles = await getReply(botName, history, condition, personasByHandle);
        if (bubbles.length) {
          console.log(bubbles.join("\n" + botName + ": "));
          for (const b of bubbles) history.push({ name: botName, text: b });
        } else {
          console.log("(no reply)");
        }
      } catch (e) {
        console.error(e?.message || e);
      }
      console.log("");
      prompt();
    });
  }
  prompt();
}

main();
