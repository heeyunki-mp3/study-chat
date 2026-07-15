# study-chat — run from project root

.DEFAULT_GOAL := help
.PHONY: help server client clean deploy-client exit-button-on exit-button-off

# Server with optional bot names: make server, or make server BOTS="Sid Vivian Jae"
server:
	cd server && npm start -- $(BOTS)

client:
	cd client && npm run dev

deploy-client:
	./deploy.sh

# Exit Chat button toggle (SHOW_EXIT_BUTTON_ALWAYS in client/src/ChatPage.jsx).
#   off = production: button appears only after the study ends. REQUIRED before the pilot.
#   on  = testing: button always visible so you can skip the chat.
# Baked in at build time — rebuild/redeploy the client for it to take effect.
exit-button-off:
	sed -i '' 's/const SHOW_EXIT_BUTTON_ALWAYS = true;/const SHOW_EXIT_BUTTON_ALWAYS = false;/' client/src/ChatPage.jsx
	@grep -n "SHOW_EXIT_BUTTON_ALWAYS = " client/src/ChatPage.jsx

exit-button-on:
	sed -i '' 's/const SHOW_EXIT_BUTTON_ALWAYS = false;/const SHOW_EXIT_BUTTON_ALWAYS = true;/' client/src/ChatPage.jsx
	@grep -n "SHOW_EXIT_BUTTON_ALWAYS = " client/src/ChatPage.jsx

clean:
	rm -rf server/logs

help:
	@echo "  make server [BOTS=\"Sid Vivian Jae\"]  — run backend (optional bot list)"
	@echo "  make client                          — run client (Vite dev)"
	@echo "  make deploy-client                   — build & push client to study-chat-dist"
	@echo "  make exit-button-off                 — production: Exit Chat only after study ends (set before pilot!)"
	@echo "  make exit-button-on                  — testing: Exit Chat always visible"
	@echo "  make clean                           — remove server/logs"
