#!/usr/bin/env python3
"""Upload train + validation JSONL, submit fine-tune job, print fine-tuned model ID."""
import os
import sys
import time
from pathlib import Path

from openai import OpenAI

BASE_MODEL = "gpt-4o-mini-2024-07-18"
SERVER_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = SERVER_DIR / ".env"


def load_env():
    """Load .env into os.environ (run from server/ or scripts/)."""
    if not ENV_PATH.is_file():
        return
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"").replace("\\n", "\n")
            if key:
                os.environ.setdefault(key, value)


def main():
    load_env()
    if len(sys.argv) < 2:
        print("Usage: python fine_tune_bot.py <job_id>", file=sys.stderr)
        sys.exit(1)

    job_id = Path(sys.argv[1])

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Set OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key)

    job = client.fine_tuning.jobs.retrieve(job_id)
    print(job)
    print(f"  status: {job.status}")


if __name__ == "__main__":
    main()
