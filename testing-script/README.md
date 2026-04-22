# Testing Script

Simulates a study session against the production server (`https://focusgroup.cc.gatech.edu/`).

## Setup

```bash
cd testing-script
npm install
```

## Usage

```bash
node simulate.mjs        # 1 session
node simulate.mjs 2      # 2 parallel sessions
node simulate.mjs 5      # 5 parallel sessions
```

## What it does

- Connects to the production server via socket.io
- Joins as participant "Hailey" (or "Hailey1", "Hailey2", etc. for multiple sessions)
- Automatically responds to moderator prompts with predefined answers
- Prints real-time status of each session to the console
- Times out after 15 minutes if study doesn't complete
