# Notes

## 1. Todo List

- (nothing yet)

## 2. Issue

### Deploying to Plesk (focusgroup.cc.gatech.edu) — 2026-04-09

Migrated from localhost to Georgia Tech Plesk server. Six issues found and fixed:

1. **Client hardcoded localhost URLs** — `ChatPage.jsx` and `LoginChoice.jsx` had `http://127.0.0.1:3001` baked in. Fixed with `import.meta.env.DEV ? "http://127.0.0.1:3001" : ""` so dev uses localhost, production uses same-domain relative paths.

2. **CORS missing production domain** — Socket.io CORS_ORIGINS only had localhost. Added `https://focusgroup.cc.gatech.edu`. Also had to move CORS_ORIGINS declaration before `app.use(cors(...))` to avoid temporal dead zone error.

3. **`express.json()` breaking socket.io** — Global `app.use(express.json())` was intercepting socket.io POST polling requests (400 errors). Removed global middleware, applied `express.json()` only on `/api/auth_choice` route.

4. **Express 5 wildcard syntax** — `app.get("*", ...)` crashes in Express 5. Changed to `app.get("/{*path}", ...)`.

5. **Missing `.env` on server** — `.env` is gitignored so it doesn't deploy via git. Plesk "Custom environment variables" are NOT passed to `process.env` by Passenger. Had to manually create `.env` in Plesk File Manager at `/server/server/.env` with OPENAI_API_KEY and DB credentials.

6. **WebSocket not supported** — Plesk/Passenger proxy doesn't forward WebSocket upgrade headers. No access to nginx config on GT Plesk. Fixed by using `transports: ["polling"]` only in client socket.io config.

**Deploy workflow:**
- Client changes: `cd client && npm run build` → scp `dist/` to server
- Server changes: git push → git pull on server → Plesk **Restart App**
- `.env` must be maintained manually on server

### Moderator double-asking fix — 2026-04-09

Eunice was answering a bot's question and then re-asking the discussion question, causing double questions. Root cause: `generateModeratorQuestionAnswer()` returned 2 bubbles (answer + question reminder), then `advanceCallOn()` also generated a cue with the question.

Fix: Changed the prompt and parser so the moderator only returns the answer (1 bubble), never re-asks. The `advanceCallOn()` cue is the only place the next question should come from.

## 3. Ideas & Backlog

- (nothing yet)
