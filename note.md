# Notes

## 1. Todo List

- ~~**Bot language realism**: Mina and other bots text in too-proper English. Update prompts so they type more like real humans (abbreviations, typos, casual grammar, etc.)~~ **Done** — Mina's texting style updated across all 4 variants (default, pro, anti, control): all lowercase, only `.` punctuation (never at end of last sentence), `??` and `!!` for questions/exclamations, no apostrophes/commas/quotes/dashes.
- **Derek pro passkey tone check**: Verify Derek's pro persona actually sounds like he enjoys/supports passkeys in practice (prompt says "cautiously supportive" — may need to be warmer)
- **Fix routing**: Correct the flow — where users start, where they go after chat ends, etc. (maybe separate branch)
- **Prolific integration**: Learn how to hook from Prolific into our app and back; need a way to track participant identity throughout the routing

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

**Transcript example showing the problem:**
```
[Eunice] Have you seen or heard about passkey before?
         If you've used it, what made you decide to switch? If you haven't, what held you back?
[Eunice] @Mina, what do you think?
[Mina]   I've seen the option pop up on my iPhone when logging into apps, but honestly, I'm not sure what all it does exactly.
         If it makes logging in faster and easier, I might try switching, but I'd need to know it won't mess with my usual FaceID stuff.
[Eunice] Passkeys use your device and biometric data for login instead of passwords making it faster and secure.  <-- PROBLEM: answers again
         Sounds like you've noticed passkeys on your iPhone and want to know if it keeps FaceID convenience right? What do you think about giving it a try?  <-- PROBLEM: re-asks
[Eunice] Makes sense to want it seamless with your current setup. @Derek, have you tried passkeys or thought about switching?  <-- advanceCallOn cue (this is correct)
```
The moderator was emitting 3 messages instead of 1. After fix, only the `advanceCallOn` cue to the next person should appear.

### Session lost on reconnect — 2026-04-09

When socket.io connection dropped (400 error, network blip), the server set `session = null` on disconnect and the client sent `participant_name` again on reconnect, creating a brand new session. All chat history was lost.

Fix:
- **Server**: Added `activeSessions` Map that stores sessions by sessionId. On disconnect, session stays in the map for 30 min (TTL). Added `rejoin` event that restores the session from the map.
- **Client**: On connect, checks `sessionStorage` for existing sessionId. If found, emits `rejoin` instead of `participant_name`. If rejoin fails (session expired), falls back to new session. Seed now replaces messages instead of appending (prevents duplicates on rejoin).

### Control group added — 2026-04-13

Added a 4th group type: `control`. Differences from pro/anti/half:
- **Moderator script**: Same intro + first big question. Polls changed to "satellite phone communication" and "generative AI" (no passkey poll). Final big question asks about generative AI usage instead of passkeys.
- **Bots**: `sid_control`, `mina_control`, `derek_control` — copied word-for-word from pro versions.
- **Rotation**: `["pro", "anti", "half", "control"]` — control is now in the round-robin.
- **Implementation**: `MODERATOR_SCRIPT` replaced with `getModeratorScript(group)` which returns `MODERATOR_SCRIPT_CONTROL` for control group, `MODERATOR_SCRIPT_DEFAULT` otherwise.

Files changed: `server/index.js`, `server/personas.json`

### Stricter question answering + neutral Eunice — 2026-04-15

Eunice was answering when Mina just said "I'm not sure what passkey is" (uncertainty, not a question). Also Eunice was hyping passkeys ("it's very easy! next generation!").

Fix:
- **Classifier prompt** (`classifyHumanMessage`): Tightened to require an explicit direct question form. Expressions of uncertainty/confusion ("I'm not sure what X is", "never heard of X") are now explicitly listed as NOT questions.
- **Moderator answer prompt** (`generateModeratorQuestionAnswer`): Added instruction to stay completely neutral and factual — no promoting, hyping, or enthusiasm about any technology.

### Temperature added to API calls — 2026-04-15

All 9 OpenAI API calls had no temperature set (using OpenAI default of 1.0). Added explicit temperature:
- `temperature: 0.7` for generative calls (bot responses, moderator cues, follow-ups, summaries, question answers) — consistent but not robotic
- `temperature: 0` for classifier/utility calls (question detection, substantive check, disagreement detection) — deterministic

### Idle nudge/kick rework — 2026-04-21

Changed from 1 nudge + kick to 2 nudges + kick:
- **Nudge 1**: Gentle reminder generated via OpenAI (temperature 0). Must include `@user`, gently asks to share thoughts. Fallback: "Hey @user, would love to hear your thoughts on this one whenever you're ready."
- **Nudge 2**: "Still there?" style generated via OpenAI (temperature 0). Must include `@user`. Fallback: "Hey @user, still around? Your thoughts on this would be great."
- **Kick (nudge 3)**: Fixed text: "No worries @user, looks like you got pulled away. We'll wrap things up on your end so the group can keep going. Thanks for signing up!"
- `MAX_NUDGES` changed from 2 to 3.
- Added `generateNudgeMessage()` function.

### Introduced name vs display name — 2026-04-22

Users enter a name on the welcome page ("Anthony") but may introduce themselves differently in chat ("Tony"). Now tracking both:
- `session.humanDisplayName` = welcome page name (used for `@` mentions)
- `session.introducedName` = name extracted from intro message via OpenAI (used for non-`@` references by bots)
- `getHumanReferenceName(session)` helper returns introduced name if available, else display name
- `extractIntroducedName()` uses OpenAI (temperature 0) to parse names from intro text
- Bot prompts and transcripts use introduced name; moderator `@` cues use display name
- Disagreement `resolve()` also recognizes the introduced name

This feature existed before (commit `c439662`) using regex but was removed. Restored with OpenAI-based extraction instead of regex.

### Nudge messages ignored intro context — 2026-04-22

During intro phase, nudge messages said generic "hear what you think about this" instead of asking the user to introduce themselves. The `waitingForHumanIntro` flag was correctly set and the context was passed to `generateNudgeMessage()`, but the LLM was ignoring the intro context and returning generic question-phase text.

Fix: The LLM prompt and context were already correct (phase detection, `phaseDesc`, examples all present). The issue was the LLM ignoring the intro context. Kept LLM generation for all phases (intro, poll, question) with intro-specific fallbacks if LLM fails:
- Fallback nudge 1: "Hey @user, would you like to introduce yourself?"
- Fallback nudge 2: "Hey @user, still with us? We'd love to hear a quick intro from you."

## 3. Ideas & Backlog

- (moved to Todo List above)
