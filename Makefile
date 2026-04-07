# study-chat — run from project root

.DEFAULT_GOAL := help
.PHONY: help server client clean deploy-client

# Server with optional bot names: make server, or make server BOTS="Sid Vivian Jae"
server:
	cd server && npm start -- $(BOTS)

client:
	cd client && npm run dev

deploy-client:
	./deploy.sh

clean:
	rm -rf server/logs

help:
	@echo "  make server [BOTS=\"Sid Vivian Jae\"]  — run backend (optional bot list)"
	@echo "  make client                          — run client (Vite dev)"
	@echo "  make deploy-client                   — build & push client to study-chat-dist"
	@echo "  make clean                           — remove server/logs"
