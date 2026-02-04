# study-chat Makefile — run from project root
# Pass bot name or job ID directly: make finetune Mina, make status ftjob-xxx
# Python targets (finetune, status) use server/.venv if present — run "make venv" once to fix "openai not found"

.DEFAULT_GOAL := help
.PHONY: finetune prettify to-jsonl status server client chat venv help

# Use venv Python from server/ if it exists (avoids "openai not found" when system python differs)
PY := (test -f .venv/bin/python3 && .venv/bin/python3 || python3)

# --- Create Python venv in server/ and install openai (fixes "ModuleNotFoundError: No module named 'openai'")
# Usage: make venv   (run once from project root, or from server/)
venv:
	cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
	@echo "Done. Use \"make finetune Mina\" etc.; the Makefile will use server/.venv automatically."

# --- Bot fine-tuning: upload train/valid JSONL and submit fine-tune job
# Usage: make finetune Mina
finetune: BOT := $(word 1,$(filter-out finetune,$(MAKECMDGOALS)))
finetune:
	@if [ -z "$(BOT)" ]; then echo "Usage: make finetune <name>  (e.g. make finetune Mina)"; exit 1; fi
	cd server && $(PY) scripts/fine_tune_bot.py fine_tune_data/$(BOT).train.jsonl fine_tune_data/$(BOT).valid.jsonl

# --- Prettify JSONL for human reading (compact -> multi-line)
# Usage: make prettify Mina
prettify: BOT := $(word 1,$(filter-out prettify,$(MAKECMDGOALS)))
prettify:
	@if [ -z "$(BOT)" ]; then echo "Usage: make prettify <name>  (e.g. make prettify Mina)"; exit 1; fi
	cd server && node scripts/prettify_jsonl.js $(BOT)

# --- Convert prettified JSONL back to compact one-line-per-record JSONL
# Usage: make to-jsonl Mina
to-jsonl: BOT := $(word 1,$(filter-out to-jsonl,$(MAKECMDGOALS)))
to-jsonl:
	@if [ -z "$(BOT)" ]; then echo "Usage: make to-jsonl <name>  (e.g. make to-jsonl Mina)"; exit 1; fi
	cd server && node scripts/to_jsonl.js $(BOT)

# --- Print status of a fine-tune job
# Usage: make status ftjob-abc123
status: JOBID := $(word 1,$(filter-out status,$(MAKECMDGOALS)))
status:
	@if [ -z "$(JOBID)" ]; then echo "Usage: make status <job_id>  (e.g. make status ftjob-abc123)"; exit 1; fi
	cd server && $(PY) scripts/check_status.py $(JOBID)

# --- Run the backend server
server:
	cd server && npm start

# --- Run the client (Vite dev server)
client:
	cd client && npm run dev

# --- Run chat fine-tune CLI (interact with a bot model)
# Usage: make chat Mina   or   make chat Mina control
chat: CHAT_BOT := $(word 1,$(filter-out chat,$(MAKECMDGOALS)))
chat: CHAT_CONDITION := $(word 2,$(filter-out chat,$(MAKECMDGOALS)))
chat:
	@if [ -z "$(CHAT_BOT)" ]; then echo "Usage: make chat <name> [condition]  (e.g. make chat Mina control)"; exit 1; fi
	cd server && node scripts/chat_finetune_cli.js $(CHAT_BOT) $$([ -n "$(CHAT_CONDITION)" ] && echo "--condition $(CHAT_CONDITION)")

help:
	@echo "study-chat Makefile"
	@echo ""
	@echo "  make venv              — create server/.venv and install openai (fix \"openai not found\")"
	@echo "  make finetune <name>   — run fine-tuning (e.g. make finetune Mina)"
	@echo "  make prettify <name>   — prettify JSONL for reading (e.g. make prettify Mina)"
	@echo "  make to-jsonl <name>  — convert prettified back to compact JSONL (e.g. make to-jsonl Mina)"
	@echo "  make status <job_id>   — print fine-tune job status (e.g. make status ftjob-abc123)"
	@echo "  make server           — run backend server"
	@echo "  make client           — run client (Vite dev)"
	@echo "  make chat <name> [condition] — run chat CLI (e.g. make chat Mina control)"
	@echo "  make help             — this help"

# Catch-all: treat extra words as args, not targets (so "make finetune Mina" doesn't try to build target "Mina")
%:
	@:
