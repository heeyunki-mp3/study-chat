# Notes

## 1. Todo List

- ~~**Bot language realism**: Mina and other bots text in too-proper English. Update prompts so they type more like real humans (abbreviations, typos, casual grammar, etc.)~~ **Done** — Mina's texting style updated across all 4 variants (default, pro, anti, control): all lowercase, only `.` punctuation (never at end of last sentence), `??` and `!!` for questions/exclamations, no apostrophes/commas/quotes/dashes.
- ~~**Prolific integration**~~ **Done** — URL params parsed on entry, saved to DB, passed to Qualtrics iframe
- **Derek pro passkey tone check**: Verify Derek's pro persona actually sounds like he enjoys/supports passkeys in practice (prompt says "cautiously supportive" — may need to be warmer). Note: Derek is no longer deployed (replaced by Anthony) but personas kept in file.
- **Qualtrics End-of-Survey redirect** (top-window, not iframe): in the Qualtrics survey (`SV_bPBOLqFJFN18XtQ`) End-of-Survey block, switch the End-of-Survey Message to **Custom**, open the **HTML View** of the rich text editor, and paste the snippet from the chat (window.top.location.replace + postMessage fallback). The script targets the TOP window so the participant fully leaves the React app. `SurveyPage.jsx` also has a `window.addEventListener("message", …)` listener that catches `{type: "studyComplete"}` and does `window.location.replace(PROLIFIC_COMPLETE_URL)` — this is the safety net for browsers that block cross-origin top-navigation without user activation. `CompletePage.jsx` and `/complete` route are still in place but unused under this approach (kept as fallback).
- ~~**Login: user ID instead of email**~~ **Done — 2026-05-13** — `LoginChoice.jsx` step 1 renamed `EmailStep` → `UserIdStep`, input is now `type="text"` with `autoComplete="username"`, label "User ID", placeholder "Create a user ID". `isValidEmail` removed; replaced with `validateUserId` (3–32 chars, `[a-zA-Z0-9._-]`). Server contract unchanged — the three endpoints (`register-password`, `webauthn-register-options`, `webauthn-register-verify`) still receive the value under the `email` JSON key, and the DB column stays `email VARCHAR(255)` (now stores user IDs). `sessionStorage.registrationEmail` → `registrationUserId` (only writer, no readers — safe). If we later want the DB column renamed, add a migration in `server/index.js` ALTER TABLE.
- ~~**IRB consent page**: insert an IRB consent form before the welcome page. Header still on top. Agree → next → welcome; Disagree → message telling them to exit.~~ **Done — 2026-05-13** — New `ConsentPage.jsx` mounted at `/`, NamePage moved to `/welcome`. Consent stored in `sessionStorage.participantConsent = "agreed"`. NamePage has a guard `useEffect` that redirects to `/` if consent is missing. WaitingPage's `navigate("/")` back-redirect updated to `/welcome` (the user is past consent at that point, just needs to re-enter name). Prolific URL param parsing moved to ConsentPage so it's captured even for decliners; kept duplicate in NamePage for direct hits to `/welcome`. ChatPage/SurveyPage back-redirects still go to `/` — back-button forces re-consent on a new session (IRB-friendly).
- ~~**Welcome (NamePage) UX**: stop the page from scrolling, center the photo + name block, make the GT header span full width, and replace the 9-icon grid with a 3-random-icon carousel that sits to the right of the "Allow camera" circle (selecting an icon slides the row leftward; far items fade).~~ **Done — 2026-05-13** — `index.css` `.site-header` now uses `width: 100vw; margin-left: calc(50% - 50vw)` (full-bleed) and `body`/`#root` overridden to `display: block; width: 100%` so the header is guaranteed full width even if a parent has `max-width`. `NamePage.jsx` outer container is `height: calc(100vh - 61px); overflow: hidden`. Carousel: `items = [camera, ...3 random presets from profile_1..9.jpg]`, 140px circles, `gap: 24px`, translated by `-ITEM_SIZE/2 - activeIndex*STEP` so the active item is page-centered. Opacity = clamp((2.5 − distance)/1, 0, 1) (so distance-1 = full, distance-2 = 0.5, distance-3 = 0); scale falls 0.12 per step (min 0.55). Clicking a non-active item calls `selectIndex(i)` → if preset, stops the camera stream and stores URL in `capturedPhoto`; if returning to camera, clears any non-`data:` URL so the "Allow camera" button reappears. ChatPage needs no change — both data URLs and `/profile_pictures/...` URLs work in `<img src>`.

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

### Nudge messages ignored intro context — 2026-04-22 (`d62d9d8`, `38ff3aa`)

During intro phase, nudge messages said generic "hear what you think about this" instead of asking the user to introduce themselves. The `waitingForHumanIntro` flag was correctly set and the context was passed to `generateNudgeMessage()`, but the LLM was ignoring the intro context and returning generic question-phase text.

Fix: Rewrote the LLM prompt in `generateNudgeMessage()` to be much more forceful about the current phase. For intro phase, the prompt now says "INTRODUCTION phase" in caps, explicitly forbids "what you think about this", and only provides intro-style examples. Phase-specific `phaseDesc` and `style` are built with an if/else block instead of ternaries for clarity.

Also fixed the idle kick: moderator chat message says "No worries @user, looks like you got pulled away..." but the browser alert shows "You have been removed from the session." (previously both showed the same long message).

### Race condition: classify vs human_idle deadlock — 2026-04-22

Sessions were getting stuck on round 4 and timing out. Root cause: race condition between async `classifyHumanMessage` (~1s) and `human_idle` socket event.

**Normal (expected) flow:**
1. `human_message` → classify starts (~1s)
2. classify finishes → marks substantive, sets `humanRepliedThisTurn`
3. `human_idle` → sees replied, starts `advanceCallOn`
4. `advanceCallOn` completes → moves to next speaker

**Race condition (what actually happens when messages/idle fire rapidly):**
1. `human_message` → `await classifyHumanMessage()` starts (~1s)
2. While classify is running, `human_idle` fires → `humanReplied` was already set at step 1, so `advanceCallOn` starts (sets `pendingAdvanceFromIdle = true`)
3. Classify finishes → `human_message` handler **resumes after the await**, sees `pendingAdvanceFromIdle = true`, sets `cancelAdvanceFromIdle = true`
4. Running `advanceCallOn` checks cancel flag → rolls back, waits for another `human_idle`
5. **DEADLOCK** — `human_idle` already fired at step 2 and will never fire again

The core issue: `human_message` is an async handler with an `await` in the middle. Other socket events (`human_idle`) can interleave during the await. When the handler resumes, it wrongly thinks "user sent a new message during an advance" — but the advance was triggered by the *same* message's idle, not a new message.

**Fix:** Snapshot `pendingAdvanceFromIdle` **before** the `await classifyHumanMessage()`. Only cancel if the advance was already pending before classify started. If `human_idle` started the advance *during* classify, that's the legitimate advance for this message — don't cancel it.

### Elaboration prompt firing after substantive response — 2026-04-22

Related race condition. User sends "Yes" (not substantive) → `waitingForElaborationAfterNonSubstantive = true`, returns early. Then user sends a long substantive message → `clearElaborationPromptTimer()` cancels the timer but **does NOT clear `waitingForElaborationAfterNonSubstantive`**. Then `human_idle` fires while classify is running → sees flag still true → starts a **new** 5s elaboration timer → "Could you elaborate please?" even though the user already gave a substantive response.

**Fix:** Clear `waitingForElaborationAfterNonSubstantive = false` immediately when the user sends a new message (at the top of `human_message` handler), not just when classify finishes.

### humanRepliedThisTurn set too late — 2026-04-22

Another variant of the classify race condition, most visible in **poll rounds**. `humanRepliedThisTurn` and `humanRepliedDisagreementTurn` flags were set **after** `await classifyHumanMessage()`. When `human_idle` fired during classify, it checked `humanRepliedThisTurn` → still `false` → bailed out → never advanced. The idle nudge timer kept firing and eventually kicked the user, even though they had already answered.

Example: in a poll round, user sends "Yes" → classify starts → `human_idle` fires → `humanRepliedThisTurn` is false → idle handler returns without advancing → nudge fires → user answers again → same thing → eventually kicked after 3 nudges.

**Fix:** Move `humanRepliedThisTurn = true` and `humanRepliedDisagreementTurn = true` to **before** the `await classifyHumanMessage()`, right after `emitMessage`. This way `human_idle` can always see that the human responded, regardless of classify timing.

### Test script bugs — 2026-04-22

1. **Regex ordering**: `/introduce|intro/` matched before `/new features|roll out|introduces something/` because "introduces" contains "introduce". Script sent intro text to a new-features question. Fixed by reordering and tightening patterns.
2. **Nudge dedup**: Script tracked responded questions in a `Set` and skipped duplicates. Nudge messages (generated with temperature 0) produced identical text each time, so the script thought it already answered and ignored them → got kicked. Fixed by skipping dedup for nudge messages.

### Bot language style not obeyed — 2026-04-22

Bots were ignoring Language Realism rules (lowercase, no apostrophes, etc.). Two issues:

1. **`persona_prompt` buried in middle of system prompt**: The persona-specific language rules were sandwiched between IDENTITY and STYLE sections. Moved `persona_prompt` to the very end of the system prompt with header "HIGHEST PRIORITY — OVERRIDE ALL ABOVE" so the model gives it final weight.
2. **Missing Language Realism on variants**: `mina_anti`, all `sid_*` variants, and default personas had no Language Realism section. Added appropriate rules to all active personas.

### Derek → Anthony rename — 2026-04-22

Replaced Derek with Anthony as the deployed bot. Derek personas kept in `personas.json` but not spawned.
- `jae_*` IDs renamed to `anthony_*` in personas.json
- Group assignments updated in index.js
- Intro lines updated for Anthony (math teacher in Arlington)

### Removed intro cue from moderator — 2026-04-22 (`78954a2`)

After all bots introduce themselves, Eunice used to generate a cue like "Nice to meet you, @Anthony! @dfa, your turn to introduce yourself." via `generateModeratorCue` with `isIntro: true`. This was an unnecessary extra step — the human should just introduce themselves without being prompted. Removed the cue generation and `emitModeratorLine` call; now it goes straight to `waitingForHumanIntro = true` and the nudge timer.

### Control group moderator script — 2026-04-22

Control group now uses:
- Same polls as other groups (VPN, password managers) EXCEPT last poll asks about **generative AI** instead of passkeys
- Last big question asks about **generative AI** (ChatGPT, Gemini, Copilot) instead of passkeys
- This is the key difference: control group never discusses passkeys in the big question round

### Moderator cue adding information and opinions — 2026-04-22

`generateModeratorCue` was explaining technologies and adding opinions when cueing the next person. Example: Mina says "i had no idea what passkeys were" → Eunice replies "A passkey is a way to sign in using your face, fingerprint, or device instead of a password. Makes logging in way easier! @Anthony, what's your take?"

Two problems:
1. **Explaining in the cue**: The `participantAskedWhatPasskeyIs` branch told the LLM to "give ONE short sentence explaining passkey" before cueing the next person. Eunice was re-explaining passkeys even if she already explained them earlier. Changed to just acknowledge and move on — the separate `generateModeratorQuestionAnswer` function handles explanations when someone explicitly asks.
2. **Adding opinions**: The system prompt had no instruction to stay neutral. Added explicit rules: do NOT explain/define any technology, do NOT add opinions ("it's easier", "it's more secure"), stay neutral. Added bad examples showing what to avoid.

### DB: assigned_group ENUM missing 'control' — 2026-04-22

`Data truncated for column 'assigned_group'` error when saving control group sessions. The `assigned_group` column was `ENUM('pro', 'anti', 'half')` — didn't include `control`. Added `'control'` to both the CREATE TABLE and a `MODIFY COLUMN` ALTER for existing tables.

### Prolific integration — 2026-04-28

Added support for Prolific URL parameters (`PROLIFIC_PID`, `STUDY_ID`, `SESSION_ID`).

Entry URL format: `https://focusgroup.cc.gatech.edu/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`

Flow:
1. **NamePage**: Parses URL params on load, stores in `sessionStorage`
2. **ChatPage**: Sends params to server via `participant_name` socket event
3. **Server**: Stores in `session.prolificPid`, `session.prolificStudyId`, `session.prolificSessionId`; saves to DB in 3 new columns (`prolific_pid`, `prolific_study_id`, `prolific_session_id`)
4. **SurveyPage + LoginChoice**: Both pass 4 params to the Qualtrics iframe URL: `PROLIFIC_PID`, `STUDY_ID`, `PROLIFIC_SESSION_ID`, `CHAT_SESSION_ID`

Qualtrics URL: `https://gatech.co1.qualtrics.com/jfe/form/SV_bPBOLqFJFN18XtQ`

Qualtrics setup:
- Survey Flow → Add Embedded Data block (must be **above** all question blocks) with fields: `PROLIFIC_PID`, `STUDY_ID`, `PROLIFIC_SESSION_ID`, `CHAT_SESSION_ID`
- Leave values blank — Qualtrics auto-captures from URL query params
- To see the data: Data & Analysis tab → **Column Chooser** → enable the embedded data columns (they are hidden by default)

### Removed "half" group — 2026-04-28

Removed "half" from group rotation. Now cycles: pro → anti → control → pro → ...

### DB: assigned_group saves "control" as "cont" — 2026-04-28

The `assigned_group` ENUM column has a 4-char limit inherited from the original `ENUM('pro', 'anti', 'half')`. Rather than altering the column, "control" is mapped to "cont" when saving to DB.

### Qualtrics URL updated — 2026-04-29

Old URL (`qualtricsxml5jbfgkjs.qualtrics.com/...`) replaced with new GT Qualtrics URL in both `SurveyPage.jsx` and `LoginChoice.jsx`. Both now use a shared `QUALTRICS_BASE` constant and pass Prolific + chat session params.

### Test script: configurable participant name — 2026-04-22

`simulate.mjs` now accepts a second CLI arg for participant name:
- `node simulate.mjs 3 Alex` → Alex1, Alex2, Alex3
- `node simulate.mjs 1` → Hailey (default)

Answers are built per-session with the name baked in (intro text, `@name` regex match). Timeout increased from 15 → 20 min. Results now show duration (e.g. "Session 1: complete — 8.3 min").

### Qualtrics embedded data not visible — 2026-04-29

Embedded data fields (`PROLIFIC_PID`, `STUDY_ID`, etc.) were being recorded correctly by Qualtrics but not showing in the Data & Analysis table. **Solution**: In Data & Analysis → click **Column Chooser** → enable the embedded data columns. They are hidden by default.

### Post-focus-group registration & sign-in flow — 2026-04-30

Added a two-step registration flow that replaces the old `LoginChoice` (simple passkey/password button recorder). Now at `/login` (renamed from `/login-choice`).

**User flow:**
1. Chat ends → "Exit Chat" button (renamed from "Exit to Survey") → `/login`
2. **Step 1** (`/login`): Email input with RFC 5322 validation → Continue
3. **Step 2** (`/login`): Two equal method cards — Password or Passkey
   - **Password**: Inline form (min 12 chars, mixed letters/numbers/symbols) → bcrypt-hashed → account created
   - **Passkey**: WebAuthn registration ceremony via `@simplewebauthn/browser` + `@simplewebauthn/server` → credential stored as JSON
4. On success → session token stored → redirect to `/survey`
5. Auth choice (password/passkey) still recorded in `participant_responses.auth_choice` column

**New DB table**: `users` (email, password_hash, webauthn_credential, webauthn_challenge, session_token)

**New API endpoints:**
- `POST /api/focus-group/register-password` — create user with bcrypt-hashed password
- `POST /api/focus-group/webauthn-register-options` — generate WebAuthn challenge + options
- `POST /api/focus-group/webauthn-register-verify` — verify attestation, store credential

**New dependencies:**
- Server: `bcrypt`, `@simplewebauthn/server`
- Client: `@simplewebauthn/browser`

**Styling**: New `FocusGroupFlow.css` — GT brand colors (navy #003057, gold #B3A369), Geist font, two-column hero layout, study timeline component, method cards, trust footer ("Paid within 24h · Withdraw anytime").

**Production env vars needed:**
```
WEBAUTHN_RP_ID=focusgroup.cc.gatech.edu
WEBAUTHN_ORIGIN=https://focusgroup.cc.gatech.edu
```

**Files changed:** `LoginChoice.jsx` (rewritten), `FocusGroupFlow.css` (new), `App.jsx` (route rename), `ChatPage.jsx` (button text + route), `server/index.js` (imports, users table, 3 endpoints)

## 3. Ideas & Backlog

- (moved to Todo List above)
