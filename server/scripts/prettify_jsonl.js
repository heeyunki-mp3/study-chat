#!/usr/bin/env node
/**
 * Prettify JSONL (one compact JSON object per line) into multi-line human-readable format.
 * Usage: node scripts/prettify_jsonl.js <filename>
 *   e.g. node scripts/prettify_jsonl.js Mina.train.jsonl
 *   e.g. node scripts/prettify_jsonl.js Minal.train.jsonl
 * Reads fine_tune_data/<filename>, writes fine_tune_data/<name>.prettified.jsonl (e.g. Mina.train.prettified.jsonl)
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

const filename = process.argv[2];
if (!filename || typeof filename !== "string") {
  console.error("Usage: node scripts/prettify_jsonl.js <filename>");
  console.error("  e.g. node scripts/prettify_jsonl.js Mina.train.jsonl");
  process.exit(1);
}

// Accept bare name (Mina.train.jsonl) or path; resolve under fine_tune_data
const base = path.basename(filename);
if (!base.endsWith(".jsonl")) {
  console.error("Filename must end with .jsonl");
  process.exit(1);
}

const inputPath = path.join(dataDir, base);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// Output: same name with .prettified before .jsonl (e.g. Mina.train.prettified.jsonl)
const outputBase = base.replace(/\.jsonl$/, ".prettified.jsonl");
const outputPath = path.join(dataDir, outputBase);

const count = prettifyFile(inputPath, outputPath);
console.log(`${base} -> ${outputBase} (${count} records)`);
