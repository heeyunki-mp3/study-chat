#!/usr/bin/env node
/**
 * Prettify JSONL (one compact JSON object per line) into multi-line human-readable format.
 * Usage: node scripts/prettify_jsonl.js <bot_name>
 *   e.g. node scripts/prettify_jsonl.js Mina
 * Reads fine_tune_data/<BOT>.train.jsonl and .valid.jsonl, writes .train.prettified.jsonl and .valid.prettified.jsonl
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..");
const dataDir = path.join(serverDir, "fine_tune_data");

function prettifyFile(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const out = lines
    .map((line) => {
      try {
        const obj = JSON.parse(line);
        return JSON.stringify(obj, null, 2);
      } catch (e) {
        console.error(`Parse error in ${inputPath}:`, e.message);
        return null;
      }
    })
    .filter(Boolean)
    .join("\n\n");
  fs.writeFileSync(outputPath, out + (out ? "\n" : ""), "utf8");
  return lines.length;
}

const bot = process.argv[2];
if (!bot || !/^[A-Za-z]+$/.test(bot)) {
  console.error("Usage: node scripts/prettify_jsonl.js <bot_name>");
  console.error("  e.g. node scripts/prettify_jsonl.js Mina");
  process.exit(1);
}

for (const suffix of ["train", "valid"]) {
  const inputPath = path.join(dataDir, `${bot}.${suffix}.jsonl`);
  const outputPath = path.join(dataDir, `${bot}.${suffix}.prettified.jsonl`);
  if (!fs.existsSync(inputPath)) {
    console.warn(`Skip ${inputPath}: not found`);
    continue;
  }
  const count = prettifyFile(inputPath, outputPath);
  console.log(`${bot}.${suffix}.jsonl -> ${bot}.${suffix}.prettified.jsonl (${count} records)`);
}
