#!/usr/bin/env node
/**
 * Convert prettified JSONL (multi-line JSON objects) back to compact JSONL (one object per line).
 * Usage: node scripts/to_jsonl.js <bot_name>
 *   e.g. node scripts/to_jsonl.js Mina
 * Reads fine_tune_data/<BOT>.train.prettified.jsonl and .valid.prettified.jsonl, overwrites .train.jsonl and .valid.jsonl
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractObjects(s) {
  const objs = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] !== "{") break;
    let depth = 0;
    let inString = false;
    let escape = false;
    const start = i;
    for (; i < n; i++) {
      const c = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (c === "\\") escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const chunk = s.slice(start, i + 1);
          objs.push(JSON.parse(chunk));
          i++;
          break;
        }
      }
    }
  }
  return objs;
}

function toJsonl(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  const objs = extractObjects(raw);
  const lines = objs.map((obj) => JSON.stringify(obj));
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
  return objs.length;
}

const serverDir = path.resolve(__dirname, "..");
const dataDir = path.join(serverDir, "fine_tune_data");

const bot = process.argv[2];
if (!bot || !/^[A-Za-z]+$/.test(bot)) {
  console.error("Usage: node scripts/to_jsonl.js <bot_name>");
  console.error("  e.g. node scripts/to_jsonl.js Mina");
  process.exit(1);
}

for (const suffix of ["train", "valid"]) {
  const inputPath = path.join(dataDir, `${bot}.${suffix}.prettified.jsonl`);
  const outputPath = path.join(dataDir, `${bot}.${suffix}.jsonl`);
  if (!fs.existsSync(inputPath)) {
    console.warn(`Skip ${inputPath}: not found`);
    continue;
  }
  const count = toJsonl(inputPath, outputPath);
  console.log(`${bot}.${suffix}.prettified.jsonl -> ${bot}.${suffix}.jsonl (${count} records)`);
}
