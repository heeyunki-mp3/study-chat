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
    if len(sys.argv) < 3:
        print("Usage: python fine_tune_bot.py <train.jsonl> <valid.jsonl>", file=sys.stderr)
        sys.exit(1)

    train_path = Path(sys.argv[1])
    valid_path = Path(sys.argv[2])
    if not train_path.is_file() or not valid_path.is_file():
        print("Both train and valid files must exist.", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Set OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key)

    print("Uploading training file...")
    with open(train_path, "rb") as f:
        train_id = client.files.create(file=f, purpose="fine-tune").id
    print("Uploading validation file...")
    with open(valid_path, "rb") as f:
        valid_id = client.files.create(file=f, purpose="fine-tune").id

    print("Submitting fine-tune job...")
    job = client.fine_tuning.jobs.create(
        training_file=train_id,
        validation_file=valid_id,
        model=BASE_MODEL,
    )
    job_id = job.id
    print(f"Job ID: {job_id}")

if __name__ == "__main__":
    main()
