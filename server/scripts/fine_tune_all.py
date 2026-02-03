#!/usr/bin/env python3
"""
Run fine-tuning for all bots that have examples in fine_tune_data/fine_tune_data.json.
Usage: python scripts/fine_tune_all.py [Sid] [Mina] [Vivian] ...
  (no args = use all bots listed in fine_tune_data/fine_tune_data.json)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_DIR = SCRIPT_DIR.parent
FINE_TUNE_JSON_PATH = SERVER_DIR / "fine_tune_data" / "fine_tune_data.json"


def main():
    if not FINE_TUNE_JSON_PATH.is_file():
        print(f"Error: {FINE_TUNE_JSON_PATH} not found.", file=sys.stderr)
        sys.exit(1)

    with open(FINE_TUNE_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    bots_data = data.get("bots") or data
    bot_names = [k for k in bots_data if isinstance(bots_data.get(k), list) and len(bots_data[k]) >= 2]

    if len(sys.argv) > 1:
        bots = [a.strip() for a in sys.argv[1:] if a.strip()]
    else:
        bots = bot_names

    if not bots:
        print("No bots to fine-tune (need at least 2 examples per bot in fine_tune_data.json).", file=sys.stderr)
        sys.exit(1)

    for bot in bots:
        if bot not in bots_data:
            print(f"[SKIP] {bot}: not in fine_tune_data.json")
            continue
        examples = bots_data[bot]
        if not isinstance(examples, list) or len(examples) < 2:
            print(f"[SKIP] {bot}: need at least 2 examples")
            continue
        print(f"\n--- Fine-tuning {bot} ({len(examples)} examples) ---")
        rc = subprocess.call(
            [sys.executable, str(SCRIPT_DIR / "fine_tune_bot.py"), bot],
            cwd=str(SERVER_DIR),
            env=os.environ.copy(),
        )
        if rc != 0:
            print(f"[FAIL] {bot} exited with {rc}", file=sys.stderr)
            sys.exit(rc)
    print("\nDone.")


if __name__ == "__main__":
    main()
