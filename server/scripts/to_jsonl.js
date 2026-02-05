#!/usr/bin/env node
/**
 * Convert prettified JSONL (multi-line JSON objects) back to compact JSONL (one object per line).
 * Usage: node scripts/to_jsonl.js <filename>
 *   e.g. node scripts/to_jsonl.js Mina.train.prettified.jsonl
 * Reads fine_tune_data/<filename>, overwrites fine_tune_data/<name>.jsonl (e.g. Mina.train.jsonl)
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

const filename = process.argv[2];
if (!filename || typeof filename !== "string") {
  console.error("Usage: node scripts/to_jsonl.js <filename>");
  console.error("  e.g. node scripts/to_jsonl.js Mina.train.prettified.jsonl");
  process.exit(1);
}

const base = path.basename(filename);
if (!base.endsWith(".prettified.jsonl")) {
  console.error("Filename must end with .prettified.jsonl");
  process.exit(1);
}

const inputPath = path.join(dataDir, base);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const outputBase = base.replace(/\.prettified\.jsonl$/, ".jsonl");
const outputPath = path.join(dataDir, outputBase);

const count = toJsonl(inputPath, outputPath);
console.log(`${base} -> ${outputBase} (${count} records)`);
