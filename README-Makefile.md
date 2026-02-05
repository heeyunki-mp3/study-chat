# How to Use the Makefile

Run all commands from the **project root** (`study-chat/`).

To see a short list of targets anytime:

```bash
make help
# or just
make
```

---

## Quick reference

| Target | Usage | Description |
|--------|--------|-------------|
| **venv** | `make venv` | Create Python venv in `server/` and install `openai` (fixes “openai not found”) |
| **finetune** | `make finetune Mina` | Run fine-tuning for a bot |
| **prettify** | `make prettify Mina.train.jsonl` | Prettify JSONL for editing (pass filename) |
| **to-jsonl** | `make to-jsonl Mina.train.prettified.jsonl` | Convert prettified back to compact (pass filename) |
| **status** | `make status ftjob-xxx` | Check fine-tune job status |
| **server** | `make server` | Start the backend |
| **client** | `make client` | Start the frontend (Vite) |
| **chat** | `make chat Mina` or `make chat Mina control` | Run chat CLI with a bot |
| **help** | `make help` | Show this help |

---

## Bot name (pass directly)

For `finetune` and `chat`, pass the **bot name** directly (e.g. Mina). For `prettify` and `to-jsonl`, pass the **filename** (e.g. Mina.train.jsonl). Bot name is the prefix of the JSONL files in `server/fine_tune_data/`:

- **Mina** → `Mina.train.jsonl`, `Mina.valid.jsonl`
- **Sid** → `Sid.train.jsonl`, `Sid.valid.jsonl`
- **Vivian** → `Vivian.train.jsonl`, `Vivian.valid.jsonl`

Use the same name you use in filenames (e.g. `Mina`, not `mina`).

---

## 0. Python venv (fix “openai not found”)

If you get **`ModuleNotFoundError: No module named 'openai'`** when running `make finetune` or `make status`, create a venv and install dependencies once:

```bash
make venv
```

This creates `server/.venv`, installs `openai` from `server/requirements.txt`, and from then on `make finetune` and `make status` will use that Python automatically.

---

## 1. Fine-tuning a bot

Uploads train/valid JSONL and starts an OpenAI fine-tune job.

```bash
make finetune Mina
```

**Requires:**

- `OPENAI_API_KEY` (e.g. in `server/.env`)
- Python 3 with `openai`: run `make venv` once (or `cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`)
- Files: `server/fine_tune_data/<BOT>.train.jsonl` and `<BOT>.valid.jsonl`

**Output:** Prints the **Job ID** (e.g. `ftjob-abc123`). Use it with `make status <job_id>` and later put the finished model ID in `server/models.json` under `bots.<bot_name>`.

---

## 2. Prettify JSONL (for humans)

Turns compact, one-line-per-record JSONL into multi-line, indented JSON so you can read and edit it.

```bash
make prettify Mina.train.jsonl
# or any .jsonl file: make prettify Minal.train.jsonl
```

**Reads:** `server/fine_tune_data/<filename>` (e.g. Mina.train.jsonl)  
**Writes:** same name with `.prettified` before `.jsonl` (e.g. Mina.train.prettified.jsonl)

Edit the `.prettified.jsonl` file, then convert back with `make to-jsonl Mina.train.prettified.jsonl`.

---

## 3. Convert back to JSONL (compact)

After editing the prettified files, convert them back to compact JSONL (one JSON object per line) and overwrite the original train/valid files.

```bash
make to-jsonl Mina.train.prettified.jsonl
```

**Reads:** `server/fine_tune_data/<filename>` (must end with `.prettified.jsonl`)  
**Overwrites:** same name with `.prettified` removed (e.g. Mina.train.jsonl)

---

## 4. Check fine-tune job status

```bash
make status ftjob-abc123
```

Use the Job ID printed when you ran `make finetune Mina`. Requires `OPENAI_API_KEY` and Python `openai` (run `make venv` if you get “openai not found”).

---

## 5. Run the server

```bash
make server
```

Starts the backend (Node) from `server/`. Default port is usually 3001.

---

## 6. Run the client

```bash
make client
```

Starts the Vite dev server for the frontend from `client/`. Use a separate terminal from the server.

---

## 7. Chat with a bot (CLI)

Interactive CLI using the fine-tuned (or default) model for a bot.

```bash
make chat Mina
```

Optional condition as second argument (e.g. for prompts):

```bash
make chat Mina control
```

**Requires:** `OPENAI_API_KEY` (e.g. in `server/.env`). Uses `server/models.json` for model IDs.

---

## Typical workflow

1. **One-time: Python venv (if you hit “openai not found”)**  
   ```bash
   make venv
   ```

2. **Edit training data (optional)**  
   ```bash
   make prettify Mina.train.jsonl
   # Edit server/fine_tune_data/Mina.train.prettified.jsonl
   make to-jsonl Mina.train.prettified.jsonl
   ```

3. **Start a fine-tune job**  
   ```bash
   make finetune Mina
   # Note the Job ID
   ```

4. **Check job status**  
   ```bash
   make status ftjob-xxxxx
   ```

5. **When the job is done**, put the new model ID in `server/models.json` under `bots.Mina`.

6. **Run the app**  
   ```bash
   make server   # terminal 1
   make client   # terminal 2
   ```

7. **Try the bot in the CLI**  
   ```bash
   make chat Mina
   ```
