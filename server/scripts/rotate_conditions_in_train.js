#!/usr/bin/env node
/**
 * Rotate systemPrompt conditions in a .train.jsonl file.
 * Replaces the trailing "Condition: ..." in each system message with
 * control, norm, authority, accountability, skeptic in turn.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAIN_PATH = path.join(__dirname, "..", "fine_tune_data", "Mina.train.jsonl");

const CONDITIONS = [
  "Condition: Be neutral. Discuss pros/cons. Do NOT push passkeys.",
  "Condition: Subtly imply passkeys are common/normal. Mention you use them sometimes. No pressure.",
  "Condition: Sound confident/tech-savvy but casual. Give short practical tips.",
  'Condition: Add gentle compare/commit cues ("we should compare later").',
  "Condition: Raise realistic doubts (lockout/device loss) without being extreme.",
];

/** Split concatenated JSON objects by top-level brace matching (ignore inside strings) */
function splitJsonRecords(raw) {
  const records = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = 0;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        records.push(raw.slice(start, i + 1));
      }
      continue;
    }
  }
  return records;
}

function main() {
  const raw = fs.readFileSync(TRAIN_PATH, "utf8");
  const chunks = splitJsonRecords(raw);
  const records = chunks.map((s) => JSON.parse(s));

  for (let i = 0; i < records.length; i++) {
    const sys = records[i].messages?.find((m) => m.role === "system");
    if (!sys?.content) continue;
    const cond = CONDITIONS[i % CONDITIONS.length];
    sys.content = sys.content.replace(/\n\nCondition: [^\n]+$/, "\n\n" + cond);
  }

  const out = records.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(TRAIN_PATH, out, "utf8");
  console.log(`Updated ${records.length} records with rotated conditions (control, norm, authority, accountability, skeptic).`);
}

main();
