# Notes

## MASTER TODO (updated 2026-07-09 — details in §0a, §1, and the dated §2 entries)

### Open — before launch
- [ ] **Use the real no-consent Prolific code (C8ZQ9LBY)** — opened 2026-07-09
- [ ] **Record how each session ended in the DB** (completed / attention kick / unsubstantial / trolling / no consent / dropped out + where) — opened 2026-07-09
- [ ] **Fix: disagreement reply erases the round's earlier answer in the DB** — opened 2026-07-09
- [ ] **Add copy: "you'll be returned to Prolific after the survey"** — opened 2026-07-09
- [ ] **Add copy: "you will sign in with this account" (login page, middle paragraph)** — opened 2026-07-09
- [ ] **Qualtrics: re-apply the End-of-Survey redirect to the live survey** — opened 2026-05-13
- [ ] **Qualtrics: fix the account-access-techniques question (real options + multi-select)** — opened 2026-07-09
- [ ] **Qualtrics: fix the 2FA question** — opened 2026-07-09
- [ ] **Qualtrics: capture device type** — opened 2026-07-09
- [ ] **Qualtrics: confirm the pw_vs_pk embedded-data field is set up** — opened 2026-06-25
- [ ] **Clarify "exit survey falsify" with prof, then do it** — opened 2026-07-09

### Open — launch day (2026-07-10, in order)
- [ ] **Back up, then wipe test data (DB + Qualtrics + archive transcripts)** — opened 2026-07-09
- [ ] **Set SHOW_EXIT_BUTTON_ALWAYS back to false, rebuild, upload dist** (⚠️ currently true) — opened 2026-07-09
- [ ] **Deploy server (git pull + Plesk restart — runs the new column ALTERs)** — opened 2026-07-09
- [ ] **Smoke-test a full run on production (all three Prolific exit codes)** — opened 2026-07-09
- [ ] **Check the DB export merges with the Qualtrics CSV** — opened 2026-07-09
- [ ] **Launch the pilot (mid-day)** — opened 2026-07-09

### Open — nice-to-have
- [ ] **Make Eunice type a bit quicker** — opened 2026-07-09
- [ ] **Shorten bot answers on the last big question** — opened 2026-07-09
- [ ] **Slow down the wrap-up (3 bubbles land in ~11s; proposal pending)** — opened 2026-07-09

### Open — verify during the pilot
- [ ] **Eunice's bubble order: explanation → Mina → summary** — opened 2026-07-09
- [ ] **New pacing feels right (ack gap, summary hold, poll pauses)** — opened 2026-07-09
- [ ] **Prolific exit codes recorded correctly per path** — opened 2026-07-09
- [ ] **Duration columns populate sane values** — opened 2026-07-09

### Open — backlog (post-pilot)
- [ ] **Serialize all moderator messages through one queue (Option A)** — opened 2026-07-06
- [ ] **Log each moderator message with its purpose and source function** — opened 2026-07-06
- [ ] **Name the asker in LLM-generated answers too** — opened 2026-07-09
- [ ] **Derek pro-persona tone check (not deployed)** — opened 2026-04-22
- [ ] **Minor edge cases from the code review sweep** — opened 2026-07-08

### Done
- [x] **Consent form says 20 minutes** — opened 2026-07-09 · done 2026-07-09
- [x] **Consent form says $4.00** — opened 2026-07-09 · done 2026-07-09
- [x] **Decliners and kicked users auto-redirect to Prolific with a countdown** — opened 2026-07-08 · done 2026-07-08
- [x] **Exit Chat button only appears after the study ends (with testing toggle)** — opened 2026-07-09 · done 2026-07-09
- [x] **Passkey explanation names the asker ("Good question @Mina!")** — opened 2026-07-09 · done 2026-07-09
- [x] **Out-of-order Eunice bubbles fixed (order now guaranteed)** — opened 2026-07-06 · done 2026-07-09
- [x] **Answered prof: where messages land in the CSV** — opened 2026-07-09 · done 2026-07-09
- [x] **Login payouts show +$4 today / +$10 follow-up** — opened 2026-07-09 · done 2026-07-09
- [x] **Login page no longer reads like the end of the study** — opened 2026-07-09 · done 2026-07-09
- [x] **Survey no longer hidden behind the GT header** — opened 2026-07-09 · done 2026-07-09
- [x] **Consent form vertically centered** — opened 2026-07-09 · done 2026-07-09
- [x] **Transcript header includes session ID + Prolific PID** — opened 2026-07-08 · done 2026-07-08
- [x] **Funnel stage durations recorded in the DB** — opened 2026-07-08 · done 2026-07-08
- [x] **Messages lost to connection drops are resent on rejoin** — opened 2026-07-09 · done 2026-07-09
- [x] **Poll bots think longer before answering + 40% chance of a longer answer** — opened 2026-07-09 · done 2026-07-09
- [x] **Poll summary waits for Mina's ack (while appearing to keep typing) + pause before next question** — opened 2026-07-09 · done 2026-07-09
- [x] **Study-goal "Ok!" always lands before the first question (with a 0.6-0.8s gap)** — opened 2026-07-09 · done 2026-07-09
- [x] **Camera-stream leak, stale typing indicator, missing nudge re-arm fixed** — opened 2026-07-08 · done 2026-07-08
- [x] **Dead-code cleanup + full edge-case review** — opened 2026-07-08 · done 2026-07-08

## 0a. Pilot feedback todos — prof notes, received 2026-07-09 (detail/status record; open items tracked in MASTER TODO above)

From "Notes for Focus Group.pdf". Status checked against the code on 2026-07-09.

**App code — open:**
- **P1. Consent form: study length 15 → 20 minutes.** ✅ Done — 2026-07-09. Both occurrences in `ConsentPage.jsx` now say "approximately 20 minutes".
- **P2. Consent form: payment $3.00 → $4.00.** ✅ Done — 2026-07-09 (`ConsentPage.jsx`).
- **P4. ⚠️ IMPORTANT — Exit Chat button clickable during the whole chat**, letting participants skip the focus group entirely. ✅ Done — 2026-07-09. The footer button in `ChatPage.jsx` now renders only once `study_complete` fires. Testing escape hatch: `SHOW_EXIT_BUTTON_ALWAYS` constant at the top of `ChatPage.jsx` — set `true` to keep the button always visible while testing, `false` for production. ⚠️ MUST be `false` before launching the pilot (it currently is). Minor UX note: Eunice's 2nd wrap-up bubble mentions the button a few seconds before it appears (it shows after her 3rd bubble, when `study_complete` is emitted) — acceptable.
- **P5. Eunice should type a bit quicker.** ⬜ Knobs: `EXPLANATORY_TYPING_DELAY_MS` (fixed 3–5s broadcasts) and the shared `TYPING_SPEED` 0.8–1.4 w/s used for her human-paced messages — a faster moderator-only speed partially re-introduces what item 1 removed, so tune carefully.
- **P6. Name the asker when Eunice answers the passkey question.** ✅ Done — 2026-07-09 (fixed-explanation part). New `personalizedPasskeyExplanation(askers)` decorates the EMITTED text only: "Good question @Mina! …" when only Mina asked; "Good question @Mina @Test! …" when the human asked too (mentions in ask order, so human-primary reads "@Test @Mina"). All internal matching/storage (`alreadyExplained`, `isPasskeyAnswer`, `answeredQuestions`, the canned-follow-up trigger) still uses the canonical `PASSKEY_EXPLANATION[0]` — so the controlled-stimulus wording is unchanged apart from the mention. Tracking flags on pollState: `minaAskedPasskey` (set in cAABQ's passkey branch), `humanAskedPasskey` (set in the human_message passkey path before the claim check); each emit site computes the mentions at SEND time. Covered sites: Mina-primary (cAABQ claim branch), human-primary (hand-rolled block), and the generic human path outside polls (last big question). The client renders the @names as colored mention chips. NOT covered (rarely relevant): the LLM-generated recap/answers (`generateModeratorQuestionAnswer`) don't name the asker — extend its prompt if wanted later.
- **P8. Bot passkey answers too long** (two separate notes: Sid's 2-bubble negative answer → cut to 1 bubble / one line, and another 2-bubble Sid answer → merge to one bubble, ~2 sentences). ⬜ The `shorten` flag currently applies only to control-group big questions and the pro/anti FIRST big question — the last (passkey/genAI) big question is unshortened with up to 3 bubbles. Likely fix: shorten the LAST big question too (or cap Sid's `max_bubbles`).
- **P9b. Bug found while answering P9:** when the participant answers a **disagreement follow-up**, `humanMessagesThisRound` is reset, so `saveCurrentRoundResponses` OVERWRITES that round's earlier call-on answer in the q-column with only the disagreement reply (the original answer survives only in the transcript txt). Should append. ⬜
- **P10. Record kicks in the DB.** ⬜ Kick reason (idle / unsubstantial / inappropriate) is currently NOT in the DB — only in server logs + the transcript. Add e.g. an `exit_status` column written on the three kick paths (and "completed" at wrap-up) so it shows in the CSV.
- **P11. Login page follow-up payout +$3 → +$10.** ✅ Done — 2026-07-09 (`StudyTimeline` in `LoginChoice.jsx`, shown on both steps). ALSO changed "Today +$3" → "+$4" to match the consent form's $4.00 (P2) — same payment, would otherwise contradict the consent form. Flag to prof in case Today should stay $3.
- **P12. Login page reads like the end of the study** (major issue). ✅ Done — 2026-07-09. All four changes in `LoginChoice.jsx`: (a) highlighted `NotFinishedBanner` ("**You're not finished yet!** Please select a User ID and login method to access the final questions and complete the survey.") — full-width yellow strip (`.fg-notice-banner` in FocusGroupFlow.css), shown on BOTH steps since the leave-early risk also exists on step 2; (b) h1 "Register to continue" → "One more step to finish the study"; (c) hero copy "Create an account to submit…" → "Select a User ID and login method to submit…"; (d) "Returning participant? Log in" link removed.
- **P13. Survey page: instruction line hidden behind the GT header.** ✅ Done — 2026-07-09. `.survey-page` was `position: fixed; top: 0` (SurveyPage.css), sliding under the sticky 61px `.site-header` which covered "Please complete the following survey before you go". Fixed with `top: 61px`, matching the `calc(100dvh - 61px)` convention used on the other pages. The iframe also shrinks by 61px, so nothing at the bottom of the Qualtrics content gets cut off either.

**Already fixed (verify in next pilot):**
- **P3. Decline consent → Prolific no-consent URL.** ✅ Done 2026-07-08 — decliners get a 5-4-3-2-1 countdown then redirect to `…/submissions/complete?cc=C1M1NSHW`; kicked users likewise to `cc=CN7JBFL7`. Consent lives in our app (not Qualtrics), so the in-app redirect replaces the prof's suggested Qualtrics branch. ⚠️ Confirm C1M1NSHW is the exact no-consent code Prolific issued.
- **P7. Eunice's out-of-order bubbles** (answer to Mina → poll summary → second answer bubble). ✅ Believed fixed 2026-07-06, before these notes were written up: PASSKEY_EXPLANATION trimmed 2 → 1 bubble (the stray third bubble no longer exists), Fix B serializes the summary behind an in-flight explanation, and exact-count summaries ("3 of us know…") were replaced with fuzzy quantifiers. Residual edge documented under "Moderator typing-indicator race".

**Answers to prof's questions:**
- **P9. "If I write something randomly at a random point — will that appear in the CSV?"** Yes, if it's during a question round: every participant message is appended to that round's column — `q1_new_features`, `q2_vpn`, `q3_password_managers`, `q4_passkeys_heard`, `q5_passkey_switch` (JSON array of their messages, by round order). Messages sent BEFORE the first question (intro / study-goal phase) are NOT in the DB — transcript txt only. Caveat: see P9b overwrite bug.
- **P10. "If someone gets kicked, where is that recorded?"** Currently nowhere in the CSV — see todo P10.

**Qualtrics-side (survey `SV_3HIPgZRXfMvUgsu`, not in repo):**
- **P14.** "Which of the following techniques do you use to access your accounts?" — replace the broken answer options (currently mixes Likert items like "Somewhat agree") with real ones and allow MULTIPLE selections. ⬜
- **P15.** Fix the next question (about 2FA) the same way. ⬜

## 0. Open Todos

Still open. Completed work is in §0b below (item numbers are preserved there since these notes cross-reference them).

8. **Log each moderator message with its purpose and source function.** ⬜
   - **Issue / goal:** No easy way to audit the moderator flow — can't tell which function produced a given Eunice message or what its purpose/type is.
   - **Fix:** TBD — add logging that records, per moderator message: the text, its purpose/type (intro, big question, cue, ack, summary, follow-up, answer…), and the producing function.

10. **Rethink the poll summary.** ✅ Done — 2026-07-06
   - **Issue:** The "X people have used it and Y haven't" summary sounded robotic and assumed usage (a bare "yes" to the pw-manager poll came out as "you've used one" instead of "you know it"). Polls 2 and 3 also landed cold — no transition between them, felt like abrupt context switches.
   - **Fix (`server/index.js`):** (a) **Summary prompt rewrite** — `generateRoundSummary` poll branch now enforces: under 12 words, one bubble, warm/professional-but-friendly tone (bans "haha"/"lol"/"hmm"), FUZZY quantifiers only ("everyone"/"most of you"/"some of you"/"nobody") — NEVER exact counts, and strictly distinguishes USED vs HEARD-OF vs DON'T-KNOW (fixes the "assumed usage" bug). Opener variety pool baked into the prompt: "Great!", "Oh nice!", "Interesting!", "Cool!", "Perfect!", "Oh got it,", "Wonderful,", "Awesome!". Examples cover the 4 distributions (all yes / most yes / mixed / all no / some don't know). (b) **Poll lead-ins for polls 2 & 3, same bubble as the question** — two pools: `POLL_LEAD_INS_MIDDLE` (`"Moving on,"`, `"Alright, next one,"`, `"Ok, next up,"`, `"Great, next question,"`, `"Onto the next,"`) for middle polls, `POLL_LEAD_INS_LAST` (`"Lastly,"`, `"One more,"`, `"Last one,"`) for the final poll. Picked by `pickFromPool(session, pool, key)` with no-repeat-in-session (per-pool tracking via `usedPollLeadInMiddleIndices` / `usedPollLeadInLastIndices`). `withPollLeadIn(leadIn, question)` prepends the lead-in and lowercases the question's first char while preserving acronyms (`"Moving on, have you ever used or heard about VPN?"`). `advanceToNextRound` detects "is this the last poll?" by scanning `session.allRounds` for any remaining `poll` after `nextRoundIndex`. Poll 1 is unchanged — still uses the standalone `"For the next few questions…"` preamble (prof preference).

## 0b. Completed — Issues & Fixes (2026-06-29 → 2026-07-06)

23. **`PASSKEY_EXPLANATION` trimmed to 1 bubble; Mina hard-coded follow-up after Eunice explains; human/Mina passkey-question coordination.** ✅ Done — 2026-07-06
   - **Issue:** (a) The 2nd sentence of `PASSKEY_EXPLANATION` ("The passkey stays on your own device…") was extra info that read as a lecture beat. (b) After Eunice explained passkey during the passkey poll, Mina had already asked "wait whats a passkey??" and never came back — stored poll answer stayed as the question, so summaries said "some of you haven't heard of it" even after the explanation. (c) When BOTH the human and Mina asked what a passkey is during the passkey poll, Eunice emitted the full fixed explanation TWICE (once for each), which read like a broken record.
   - **Fix (`server/index.js`):** (a) `PASSKEY_EXPLANATION` reduced from 2 → 1 bubble (dropped the 2nd sentence). Comment updated.
     (b) `checkAndAnswerBotQuestion` now takes an `askerBotName` param — all 3 callers pass it (`runBotTurn` → `botName`, `runPollRound` → `bot`, `runNextDisagreementFollowUp` → `botName`). When `askerBotName === "Mina"` AND the returned answer equals `PASSKEY_EXPLANATION[0]`, a canned follow-up fires: 2s silent "reading" pause → Mina typing indicator → `typingDelayMs("oh i dont think i have used it before")` → emit. The follow-up is written in Mina's persona style (lowercase, `dont` not `don't`, no ending period). If a `pollState` is active, `pollState.answers["Mina"]` is overwritten with the follow-up text so the poll summary reflects her real stance instead of the question.
     (c) Passkey coordination on `pollState`: `passkeyExplanationEmitPromise` (+ resolve) as a claim gate, `passkeyExplanationEmitted` (bool) as a positive "actually emitted" signal, `minaAskedPasskeyPromise` (+ resolve) as a Mina-spoke signal, all initialized in `runPollRound`. Whichever side (human_message handler OR `checkAndAnswerBotQuestion`) gets to the passkey question first claims the emit; the other side awaits the claim's promise and skips its own emit. Human primary flow (B1: human asks before Mina) is now explicit: `human_message` → think delay → typing indicator ON → `typingDelayMs(PASSKEY_EXPLANATION[0])` → `Promise.race([minaAskedPasskeyPromise, delay(20000)])` (20s stall guard) → extra 2s → emit. Result reads as "human asks → Eunice types… → Mina asks → 2s more → Eunice emits". `answerParticipantQuestion` now checks `alreadyAnswered` for the fixed explanation and falls through to `generateModeratorQuestionAnswer` if already explained (B2 fix: second asker gets a brief recap). `generateModeratorQuestionAnswer`'s "already answered" branch loosened from ~8 words → ~15 words with a "Like I mentioned above, it's a passwordless way to log in using your biometrics" example so the LLM can produce a natural recap instead of an abrupt reminder.
     (d) **Off-persona Mina reliability fix — stall guard only**: Previously, `checkAndAnswerBotQuestion` only resolved `minaAskedPasskeyPromise` inside the isQuestion-true branch, so ~20-35% of runs where `gpt-4o-mini` gave Mina a statement like `"never heard of it"` instead of a `?`-form question stalled the human path for the full 20s guard window. FIX: `pollState.minaAskedPasskeyResolve()` is now called from `runPollRound`'s bot promise immediately after Mina's `emitMessage`, regardless of question form — cAABQ no longer touches it. The **canned follow-up stays in `checkAndAnswerBotQuestion`** (not moved to `runPollRound`) — it fires ONLY when Mina's answer classified as a question AND `answerBubbles[0] === PASSKEY_EXPLANATION[0]` (i.e., Eunice actually answered Mina's specific question with the fixed explanation). If Mina answered without asking a question or if the human primary path already emitted (making Mina's `answerParticipantQuestion` return an LLM recap), the follow-up doesn't fire — appropriate, because the "oh i dont think i have used it before" line only makes narrative sense after Mina asks and Eunice explains. `askerBotName` arg on `checkAndAnswerBotQuestion` retained + still passed by all 3 callers.

22. **Shorten the study-goal → first-question gap; bot ack fires in background.** ✅ Done — 2026-07-06. Ack pre-delay retuned 2026-07-09 (300ms → 1.5–2.2s, then hand-tuned to 2.2–3.2s, which broke the old timing-arithmetic ordering guarantee: worst ack 3.2+2.5=5.7s > question's earliest 5.0s). **Structural fix 2026-07-09:** the ack IIFE resolves an `ackEmitted` promise (`.finally`, so every path resolves); `runStudyGoal` passes `Promise.race([ackEmitted, delay(10000)])` to `startFirstRound({ holdFirstEmitFor })`, which feeds it to the first question's `emitModeratorLine` as `awaitBeforeSend` — Eunice types the question while the bot acks, and only the SEND waits (typing indicator stays on), same pattern as Mina's follow-up gating the poll summary. `STUDY_GOAL_ACK_PRE_DELAY_MS` is now tunable with no ceiling (soft limit ~7.5s total before the 10s hold cap truncates). Applies to both first-round branches (big question AND poll preamble); rejoin-resume calls `startFirstRound()` without the hold — fine, the ack task died with the old socket.
   - **Issue:** Between Eunice's study-goal message and the first question there was a long dead space — the bot's "Ok!" ack blocked in series (6-8s randomized think + typing + Eunice's 3-5s think), so total silence stacked to ~10-15s.
   - **Fix (`server/index.js`, `runStudyGoal` + `startFirstRound`):** Eunice no longer awaits the bot ack. After the study-goal messages: (a) the bot ack is fired as a **fire-and-forget IIFE** — 300ms pre-delay → typing indicator → `typingDelayMs(ack)` → emit; (b) Eunice waits a **fixed 2s** then calls `startFirstRound({ skipThinkDelay: true })`. `startFirstRound` accepts an opts arg and passes `skipThinkDelay` to the first `emitModeratorLine` (poll preamble OR the big-question itself) so the 2s pause isn't stacked with another `MODERATOR_THINK_DELAY_MS` (3-5s). Ordering guarantee: even the longest ack ("Got it!" at slow speed ~2.5s) lands well before Eunice's first-question emit (2s wait + 3-5s explanatory typing = t=5-7s). Removed the `STUDY_GOAL_ACK_DELAY_MS` constant (was 6-7s, added in item 14) since it's no longer referenced.

Each item: **Issue** then **Fix**. Item numbers preserved (other notes cross-reference them).

1. **Bot typing speed to feel human.** ✅ Done — 2026-06-29 (model revised 2026-06-30)
   - **Issue:** Bots typed too fast, reading as obviously bot-like. Wanted a human feel, but with the moderator able to go faster on scripted/explanatory content (a real moderator copy-pastes those) while her per-person replies stay human-speed.
   - **Fix (`server/index.js`):** `TYPING_SPEED` → `0.8–1.4` w/s (≈48–84 WPM). Two moderator modes via the `humanPace` flag on `emitModeratorLine`: (a) **Explanatory broadcasts → FIXED 3–5s** regardless of length (`EXPLANATORY_TYPING_DELAY_MS`) — intro, study goal, poll instructions/questions, the **first** big question, wrap-up; (b) **Human length-based speed** for reactions/prompts — call-on & first-speaker cues, round acks, idle nudges, "could you elaborate?", Eunice's answers, round/poll summaries, disagreement follow-ups, and the **final passkey big question**. Bots always length-based. Removed the earlier fast (3 w/s) and medium (2 w/s) moderator-speed constants; `typingDelayMs` is now purely length-based.

2. **Make Eunice's passkey explanation more informative.** ✅ Done — 2026-06-30
   - **Issue:** Eunice's passkey definition was LLM-generated (capped at ~2 short sentences), so it came out thin and varied run-to-run — bad for a controlled study stimulus.
   - **Fix (`server/index.js`):** Fixed 2-bubble canonical `PASSKEY_EXPLANATION` (identical, neutral wording for every participant): (1) *"Good question! A passkey is a passwordless way to log into websites and apps. Instead of a password, you sign in with the fingerprint, face scan, or PIN you already use to unlock your device."* (2) *"The passkey stays on your own device, and only you can activate it through those biometrics or whatever unlock method your device uses."* New `answerParticipantQuestion` helper: on a passkey round, if `isAskingWhatPasskeyIs` → return the fixed script, else fall back to `generateModeratorQuestionAnswer`. Both answer sites (bot-asked `checkAndAnswerBotQuestion` + human-asked `human_message` handler) call it and emit at **human pace** (`humanPace: true`); the 2-bubble split keeps each bubble's typing time reasonable.

3. **Fix the first big question.** ✅ Done — 2026-06-29
   - **Issue:** (a) Participants kept asking what "new features" meant — the term was too abstract. (b) The first question ate too much time.
   - **Fix (`server/index.js`, both DEFAULT & CONTROL scripts):** (a) Reworded to ground it with concrete, neutral examples (no security/login examples, to avoid priming passkeys): *"First question: Tech companies often roll out new features in apps you already use, like a redesigned layout, a new tool or button, or new AI features. When something new like that shows up, how do you usually feel? Do you try it right away, or ignore it at first?"* (b) First big question now **skips the disagreement/discussion phase** — in `advanceCallOn`, when `currentRoundIndex === 0` it goes ack → `runRoundSummary()` instead of `runDisagreementPhase()` (call-on everyone → summary → next). Later big questions still get full discussion.

4. **Reword the final (passkey) big question to avoid repetition.** ✅ Done — 2026-06-30
   - **Issue:** The final big question re-asked awareness that the preceding poll already covered — felt repetitive, like the moderator forgot. Applies to BOTH scripts: DEFAULT (passkey poll + passkey question) and CONTROL (genAI poll + genAI question).
   - **Fix (both scripts):** Reworded each to skip awareness and go experience-first (neutral, branches on what the poll already sorted). DEFAULT: *"Since some of you have already come across passkeys, I'd love to dig into that a bit. If you've tried one, how did it go, and would you keep using it? If you haven't, what's your gut reaction to the idea of switching to one?"* (no passkey explanation baked in — that's item 2). CONTROL (2026-07-01): *"Since some of you have already come across generative AI tools, I'd love to dig into that a bit. If you've tried one, how did it go, and would you keep using it? If you haven't, what's your gut reaction to the idea of trying one?"* Pacing note: briefly typed at a MEDIUM (2 w/s) speed, but item 1's revised model removed the medium speed — these are now **human-paced** like the other reaction/prompt messages.

5. **Add a clear closing wrap-up from Eunice.** ✅ Done — 2026-06-30
   - **Issue:** The old 2-line wrap-up didn't give clear next steps, and it told participants to click "End Chat" — but the actual button is labeled "Exit Chat."
   - **Fix (`advanceToNextRound`, all-rounds-done branch):** 3-bubble wrap-up covering the three required points (make an account → security matters because questions may be sensitive → same account for a paid follow-up ~2 weeks later), credentials wording kept NEUTRAL: (1) *"Thanks everyone, that wraps up our discussion for today. I really appreciate you all sharing your experiences!"* (2) *"To finish up, click the \"Exit Chat\" button below. You'll create an account and then complete a short exit survey. Some of the questions may be sensitive, so please set up your account with secure login credentials."* (3) *"You will also use this same account again in about two weeks for a paid follow-up study, so keep your login handy."* Also fixed the button label "End Chat" → "Exit Chat".

6. **Assign Mina & Sid fixed profile pics, and remove those from the user picker.** ✅ Done — 2026-06-30
   - **Issue:** Bots used generic avatars, and a participant could pick the same avatar as a bot on the welcome page.
   - **Fix:** `ChatPage.jsx` — `RESERVED_BOT_AVATARS = { Mina: "profile_8.jpg", Sid: "profile_9.jpg" }`; bot avatar in `getParticipants` uses the reserved jpg, else falls back to `${bot}.png`. `NamePage.jsx` — `PRESET_POOL` 9 → 7 so the picker only offers `profile_1..7.jpg`. Avatars render only in the participants sidebar (single source). Files already exist in `profile_pictures/`.

7. **No "huh" in any bot's text (including Eunice).** ✅ Done — 2026-06-30
   - **Issue:** Bots/Eunice output the filler word "huh" (bad example: "Clutter and broken workflows, huh @Mina").
   - **Fix (two layers):** (1) **Backstop** — `stripHuh()` in `server/index.js` removes the "huh" token (+ adjacent comma, tidies spacing), applied inside `addMessage` to ALL bot + moderator messages; guarded to skip the human's own text (echoed via `emitMessage`→`addMessage`) and word-boundary safe (won't touch "Huntsville"). (2) **Prompt rules** — `Never use the word "huh"` added to the bot system prompt HARD RULES (`prompts.js`) and the moderator cue prompt. Other moderator generators are covered by the backstop.

9. **Differentiate bots' poll answers by character.** ✅ Done — 2026-06-30
   - **Issue:** The poll prompt told every bot to return a bare lowercase "yes"/"yeah"/"no" ~50% of the time, flattening all personas into the same reply.
   - **Fix (`buildUserPrompt` + `getBotResponse`):** Two persona-driven poll variants selected by a per-bot 50/50 coin flip (`pollExplain`, `Math.random() < 0.5`). **Variant A (simple):** picks ONE from a fixed set with capitalization variety (`yes/Yes/Yeah/yeah/yea/Yea/no/No/Nope/I don't think so/i dont think so`) by the persona's real experience, casing per its Language Realism rules. **Variant B (explain):** yes/no + short reason UNDER 10 words in the persona's voice. OpenAI log label gains a `:simple`/`:explain` tag.

11. **Fix the call-on order for first and last questions.** ✅ Done — 2026-06-30
   - **Issue:** Call-on order was the initial `[bots…, user]` list rotated by one; needed specific orders — first Q: Anthony → Mina → User → Sid; last Q: Sid → Anthony → Mina → User.
   - **Fix (`server/index.js`):** Added `FIRST_BIG_Q_ORDER`, `LAST_BIG_Q_ORDER`, a `buildCallOnOrder(session, template)` helper (maps `@user`→participant, filters to present, appends any unnamed), and `lastBigQuestionIndex(session)`. First Q sets its order in `startFirstRound`; last Q in `advanceToNextRound` (replaced the rotate-by-one). Bots are always Sid/Mina/Anthony, so names are stable.

12. **Don't ask Mina the disagreement follow-up in the last question.** ✅ Done — 2026-06-30
   - **Issue:** In the final big question's discussion phase, Mina should never be the one the moderator asks the disagreement follow-up to.
   - **Fix:** In `runDisagreementPhase`, when it's the last big question, filter the deduped pair list to drop any where `disagreedWith === "Mina"` (`LAST_Q_DISAGREEMENT_EXCLUDE`). If that empties the queue, it skips straight to the round summary.

13. **Sticky top banner + fix leftover scroll.** ✅ Done — 2026-06-30
   - **Issue:** The GT banner scrolled away with content, and there was a ~61px leftover scroll on some pages.
   - **Fix:** `.site-header` in `index.css` → `position: sticky; top: 0; z-index: 20`. Leftover scroll came from full-height page roots not subtracting the 61px banner (WaitingPage used bare `100dvh`; others used `calc(100vh - 61px)` which overflows on mobile). Switched all full-height roots to `calc(100dvh - 61px)`: WaitingPage, ConsentPage (×2), NamePage, CompletePage, `.fg-page`. ChatPage (dynamic `--app-h`) and SurveyPage (iframe) untouched.

14. **Lengthen thinking delays.** ✅ Done — 2026-06-30
   - **Issue:** The silent "think" pauses before the "typing…" indicator were too short (bots felt too quick to answer).
   - **Fix (`server/index.js`):** `BOT_THINK_DELAY_MS` 3–5s → **4–6s**; `MODERATOR_THINK_DELAY_MS` 2–3s → **3–5s**; study-goal "Ok!" ack `STUDY_GOAL_ACK_DELAY_MS` from a FIXED 2s → randomized **6–8s** (converted to a `{min,max}` range via `randomBetween`). Typing-out speeds and `MODERATOR_CONSECUTIVE_DELAY_MS` unchanged.

15. **Per-persona poll wording (follow-up to #9).** ✅ Done — 2026-06-30
   - **Issue:** Bots still tended to default to "yeah", which looks unnatural when everyone says the same word.
   - **Fix:** Added a `poll_style` field to all 12 Anthony/Sid/Mina personas (`personas.json`, script-added, formatting preserved) noting each one's preferred yes/no wording — **Anthony** Yea > yeah > yes / nope > no; **Sid** Yes > yeah/yea / no > nope; **Mina** yeah > yea/yes / no > nope. `systemPrompt` surfaces it as a "POLL ANSWER WORDING" block; both poll variants in `buildUserPrompt` tell the bot to pick its form from that block.

16. **Intro acceptance too strict (caused a false kick).** ✅ Done — 2026-06-30
   - **Issue:** A participant who typed "Hiiii this is test. nice to meet you all" was rejected by `is_intro_sufficient` (`introduced:false`) — it read "this is test" as "this is a test" and "nice to meet you all" as filler — so the system stayed in intro-waiting, nudged twice, and **kicked** them.
   - **Fix (`server/index.js`):** Relaxed the `is_intro_sufficient` prompt to be lenient — accepts any sincere greeting/social engagement ("nice to meet you all", "excited to be here") even without an explicit name; still rejects ONLY bare one-word filler ("hi", "ok").

17. **Moderator cue: separate the reaction from the call-on.** ✅ Done — 2026-06-30
   - **Issue:** Cues like "Love new technology excitement @Sid" read as Eunice *describing* Sid, not *calling on* him — no punctuation between the reaction and @name, no prompt phrase.
   - **Fix (`generateModeratorCue`):** Part 2 now requires ending the reaction with punctuation (`.`/`!`/`..`) THEN @name + a SHORT prompt phrase. Added two CRITICAL RULES (never let reaction and @name run together — with the bad→good example; always add a 2–4 word prompt phrase after @name, never end with bare "@name"); fixed the one bare-"@name?" example; added the bad case to examples. Correct shape: "Love the excitement! @Sid, what about you?"

18. **Poll: ask "what is it?" when the persona doesn't know the tech (Mina + passkey).** ✅ Done — 2026-06-30
   - **Issue:** Mina's passkey awareness is `"none"`, but the SIMPLE poll variant (A) forced a yes/no from the fixed set with no clarification path, so she'd answer "no" instead of asking what a passkey is.
   - **Fix (`buildUserPrompt`):** Added an EXCEPTION to poll Variant A — if the persona genuinely doesn't know the tech, don't pick yes/no; ask a short in-voice question ("wait whats a passkey??"); if the persona has NO awareness it MUST ask. (Variant B already had this.) Reinforces the systemPrompt awareness=none block.

19. **Differentiate VPN & password-manager poll answers (everyone was saying yes).** ✅ Done — 2026-06-30
   - **Issue:** Only passkey had per-persona awareness, so for the VPN and password-manager polls every bot defaulted to "yeah I know it."
   - **Fix:** Added a `tech_experience` field to all 12 Anthony/Sid/Mina personas (`personas.json`, script-added), surfaced in `systemPrompt` as a "YOUR EXPERIENCE WITH THESE TECHNOLOGIES" block. Stances: **Sid** uses VPN + password manager; **Anthony** light/work VPN, no password manager; **Mina** VPN sometimes, no password manager. Anthony's note avoids mentioning passkeys (must not reveal before the moderator asks; pw-manager poll comes first).

20. **Chat froze when the reload/close warning was dismissed.** ✅ Done — 2026-06-30
   - **Issue:** `socket.io-client` v4 defaults `closeOnBeforeunload: true` and registers its own `beforeunload` listener that closes the socket. Our reload/close warning fires `beforeunload`; when the participant cancels (stays), the socket was already closed and never came back → chat frozen.
   - **Fix:** Set `closeOnBeforeunload: false` in the `io(...)` options in `ChatPage.jsx`, so the connection survives a cancelled reload.

21. **Eunice asked to elaborate on a complete answer ("never heard of it").** ✅ Done — 2026-06-30
   - **Issue:** Frank answered "i never heard of them before" (a valid, complete answer) but `classifyHumanMessage`'s substantive-check returned false → triggered the "Could you elaborate please?" nudge.
   - **Fix (`server/index.js`):** (1) The `substantive` classifier now counts honest "I don't know / never heard of it / not familiar" statements as complete valid answers (false ONLY for pure filler like "ok"/"idk"/"lol", off-topic, or question-only). (2) Lowered the auto-substantive word-count threshold from >15 → >10 words.

## 1. Todo List

- ~~**Bot language realism**: Mina and other bots text in too-proper English. Update prompts so they type more like real humans (abbreviations, typos, casual grammar, etc.)~~ **Done** — Mina's texting style updated across all 4 variants (default, pro, anti, control): all lowercase, only `.` punctuation (never at end of last sentence), `??` and `!!` for questions/exclamations, no apostrophes/commas/quotes/dashes.
- ~~**Prolific integration**~~ **Done** — URL params parsed on entry, saved to DB, passed to Qualtrics iframe
- **Derek pro passkey tone check**: Verify Derek's pro persona actually sounds like he enjoys/supports passkeys in practice (prompt says "cautiously supportive" — may need to be warmer). Note: Derek is no longer deployed (replaced by Anthony) but personas kept in file.
- **Qualtrics End-of-Survey redirect** (top-window, not iframe): the live survey is now `SV_3HIPgZRXfMvUgsu` (real survey, replaced pilot `SV_bPBOLqFJFN18XtQ` on 2026-05-13). In THIS survey's End-of-Survey block, switch the End-of-Survey Message to **Custom**, open the **HTML View** of the rich text editor, and paste the snippet from the chat (window.top.location.replace + postMessage fallback). The script targets the TOP window so the participant fully leaves the React app. `SurveyPage.jsx` also has a `window.addEventListener("message", …)` listener that catches `{type: "studyComplete"}` and does `window.location.replace(PROLIFIC_COMPLETE_URL)` — this is the safety net for browsers that block cross-origin top-navigation without user activation. `CompletePage.jsx` and `/complete` route are still in place but unused under this approach (kept as fallback). ⚠️ The redirect config does NOT carry over from the pilot survey — must be re-applied to `SV_3HIPgZRXfMvUgsu`.
- ~~**Log all auth method clicks**~~ **Done — 2026-05-13; reworked 2026-05-29** — `LoginChoice.jsx` SecureStep keeps `clicksRef = useRef([])`; `selectMethod` pushes every click (incl. back-and-forth switches) → e.g. `["passkey","password","passkey"]`. **Bug fixed 2026-05-29:** clicks used to be sent only with `register-password`/`webauthn-register-verify`, so they were written ONLY on successful registration — abandoned sessions and cancelled passkey prompts (`NotAllowedError` then leave) recorded nothing ("sometimes doesn't record at all"). Now `selectMethod` calls `logClicks()` which fires a `fetch("/api/focus-group/log-auth-click", {keepalive:true})` on EVERY click. New server endpoint is the SOLE writer of `auth_method_clicks` (registration endpoints no longer touch the column, avoiding null-overwrite). Server has `sanitizeAuthMethodClicks()` (filters to "password"/"passkey", caps 100, returns JSON string or null; null → endpoint no-ops so it never clobbers a prior value). Column `participant_responses.auth_method_clicks JSON` (ALTER TABLE IF NOT EXISTS in init). Production: **Plesk → Restart App** for the ALTER + new endpoint.
- ~~**Alternate password vs passkey card order + log it**~~ **Done — 2026-05-13** — Strict alternation, server-driven. New endpoint `POST /api/focus-group/assign-auth-order` looks up the participant's row, returns the stored `auth_method_top` if already set (idempotent), otherwise counts rows where `auth_method_top IS NOT NULL` and assigns `n % 2 === 0 ? "password" : "passkey"`, persisting it on the participant's row. `LoginChoice.jsx` SecureStep calls this in a `useEffect` on mount and only renders the method cards once `topMethod !== null` (shows "Loading sign-in options…" placeholder briefly). Registration endpoints no longer touch `auth_method_top` — the assignment endpoint is the sole writer. Column `participant_responses.auth_method_top VARCHAR(16)` added via ALTER TABLE IF NOT EXISTS in init block. Production: **Plesk → Restart App** for the ALTER + new endpoint to be live. Race condition note: two concurrent first-time hits could both read the same count before either UPDATEs — acceptable for a small-N study; if strict serializability is needed later, wrap the count+update in a transaction with `SELECT ... FOR UPDATE` on a sentinel row.
- ~~**Dark-mode readability fix**~~ **Done — 2026-06-25** — OS dark-mode users saw a greyed-out/unreadable page (e.g. consent form): the Vite-default `index.css` set `:root` to a dark background (`#242424`) and only switched to white inside `@media (prefers-color-scheme: light)`, so dark-mode users got a dark page behind the app's dark text. Fix: force a light scheme app-wide — `color-scheme: light`, `:root` background `#ffffff` / color `#213547`, default `button` background `#f9f9f9`, and removed the now-redundant `prefers-color-scheme: light` media query (kept its `a:hover` color). The app does NOT support a dark theme; it just always renders light for everyone.
- ~~**Route chosen auth method to Qualtrics (`pw_vs_pk`)**~~ **Done — 2026-06-25** — On *successful* registration, `LoginChoice.jsx` writes `sessionStorage.pw_vs_pk` = `"pw"` (password, set right after the `register-password` success) or `"pk"` (passkey, set right after `webauthn-register-verify` success). Recorded at the success/navigate points (not on click) so it reflects the method the participant actually completed — clicking back-and-forth between cards doesn't matter, only the ceremony that lands them on `/survey`. `SurveyPage.jsx` reads it and appends `pw_vs_pk` to the Qualtrics iframe URL alongside the existing 4 params. ⚠️ Qualtrics side (not in repo): in `SV_3HIPgZRXfMvUgsu` Survey Flow add an Embedded Data field named exactly `pw_vs_pk` (left blank), then enable its column in Data & Analysis → Column Chooser (hidden by default). Values: `pw` / `pk`.
- ~~**Login: user ID instead of email**~~ **Done — 2026-05-13** — `LoginChoice.jsx` step 1 renamed `EmailStep` → `UserIdStep`, input is now `type="text"` with `autoComplete="username"`, label "User ID", placeholder "Create a user ID". `isValidEmail` removed; replaced with `validateUserId` (3–32 chars, `[a-zA-Z0-9._-]`). Server contract unchanged — the three endpoints (`register-password`, `webauthn-register-options`, `webauthn-register-verify`) still receive the value under the `email` JSON key, and the DB column stays `email VARCHAR(255)` (now stores user IDs). `sessionStorage.registrationEmail` → `registrationUserId` (only writer, no readers — safe). If we later want the DB column renamed, add a migration in `server/index.js` ALTER TABLE.
- ~~**IRB consent page**: insert an IRB consent form before the welcome page. Header still on top. Agree → next → welcome; Disagree → message telling them to exit.~~ **Done — 2026-05-13** — New `ConsentPage.jsx` mounted at `/`, NamePage moved to `/welcome`. Consent stored in `sessionStorage.participantConsent = "agreed"`. NamePage has a guard `useEffect` that redirects to `/` if consent is missing. WaitingPage's `navigate("/")` back-redirect updated to `/welcome` (the user is past consent at that point, just needs to re-enter name). Prolific URL param parsing moved to ConsentPage so it's captured even for decliners; kept duplicate in NamePage for direct hits to `/welcome`. ChatPage/SurveyPage back-redirects still go to `/` — back-button forces re-consent on a new session (IRB-friendly).
- ~~**Welcome (NamePage) UX**: stop the page from scrolling, center the photo + name block, make the GT header span full width, and replace the 9-icon grid with a 3-random-icon carousel that sits to the right of the "Allow camera" circle (selecting an icon slides the row leftward; far items fade).~~ **Done — 2026-05-13** — `index.css` `.site-header` now uses `width: 100vw; margin-left: calc(50% - 50vw)` (full-bleed) and `body`/`#root` overridden to `display: block; width: 100%` so the header is guaranteed full width even if a parent has `max-width`. `NamePage.jsx` outer container is `height: calc(100vh - 61px); overflow: hidden`. Carousel: `items = [camera, ...3 random presets from profile_1..9.jpg]`, 140px circles, `gap: 24px`, translated by `-ITEM_SIZE/2 - activeIndex*STEP` so the active item is page-centered. Opacity = clamp((2.5 − distance)/1, 0, 1) (so distance-1 = full, distance-2 = 0.5, distance-3 = 0); scale falls 0.12 per step (min 0.55). Clicking a non-active item calls `selectIndex(i)` → if preset, stops the camera stream and stores URL in `capturedPhoto`; if returning to camera, clears any non-`data:` URL so the "Allow camera" button reappears. ChatPage needs no change — both data URLs and `/profile_pictures/...` URLs work in `<img src>`.

## 2. Issue

### Passkey-poll ordering: explanation → Mina's ack → summary, with concurrent summary write-up — 2026-07-09 (FIXED)

**Question from testing:** is the order [Eunice's passkey explanation → Mina's "oh i dont think i have used it before" → poll summary] always guaranteed? **It was NOT.** Normal path: yes (summary waited on `Promise.all(botPromises)`, which included Mina's whole chain). Grace path: no — the 15s straggler grace routinely fires mid-chain (the explanation alone types ~24-41s at human pace), and Fix B only waited for the explanation, NOT the follow-up (~7-11s later) → the summary could overtake Mina's ack, and missed her real stance in `answers`.

**Fix (with the requirement that it must NOT slow the flow — Eunice starts writing the summary a few sec after the explanation, once everyone has answered, and only the SEND waits for Mina):**
- **Deferred follow-up:** `checkAndAnswerBotQuestion` gained `opts.deferMinaFollowUp` + boolean return. Poll rounds pass it: cAABQ no longer emits Mina's canned follow-up inline; it synchronously records her stance in the poll's captured `answers` (so the summary prompt always includes it — and the write can't leak into a later poll; kills review-sweep edge #3) and returns true. `runPollRound` then fires the visible follow-up (2s pause → typing → emit) as a background task and resolves Mina's turn immediately. Non-poll callers (big questions) keep the inline emit — unchanged. Canned text extracted to `MINA_PASSKEY_FOLLOWUP`.
- **Earlier botsFinished:** since Mina's turn no longer contains the follow-up tail, `Promise.all(botPromises)` (→ summary flow) fires right after everyone's answers + Q&A are done — i.e. a few sec after the explanation, satisfying "everyone responded at least once". Non-Mina bot Q&A (Eunice answering Sid etc.) stays INSIDE turns, so two Eunice flows still can't race.
- **Send-only gate:** new `pollState.minaFollowUpDonePromise`, resolved by the background task's `finally` (or when Mina's turn ends without a follow-up — flag-guarded `turn.then` fallback, so it can't dangle). `emitModeratorLine` gained `opts.awaitBeforeSend`: awaited AFTER the type-out, right before the send, typing indicator stays on (callers must pass a bounded promise). `finishPollRound` arms it as `Promise.race([minaFollowUpDone, 20s])`, only when a passkey explanation was actually claimed — so a stuck Mina on a non-passkey poll never delays a grace-forced summary.

**Resulting timeline (both normal + grace paths):** explanation → (summary generation runs HIDDEN inside Eunice's 3-5s think — fired before the think, awaited after, `skipThinkDelay` on the emit — so typing starts exactly 3-5s after the explanation with no serial ~1s generation) ∥ (Mina: 2s pause + type ~6-10s → ack lands ~8-12s after explanation) → summary send (hold usually already resolved). Order guaranteed; near-zero added latency. (The big-question `runRoundSummary` still generates serially — different flow, no ordering constraint there.)

**2026-07-09 addition — `POST_ACK_SEND_GAP_MS = 0.6–0.8s`:** both gated sends (Mina's follow-up → poll summary, and the study-goal "Ok!" → first question) chain a gap onto the hold promise: `Promise.race([ackDone, cap]).then(() => delay(0.6–0.8s))`. The gap timer starts the moment the ack LANDS (eager chain), so send time = max(type-out end, ack + gap) — zero added delay when the ack was early; when the hold triggers, the gated message follows the ack by 0.6-0.8s instead of posting in the same instant.

### Poll bots answered too fast — 2026-07-09 (FIXED)

Poll bots shared the call-on `BOT_THINK_DELAY_MS` (4–6s), so a bare "yes" started typing ~4s after the poll question and all three bots began within a ~2s window — read as bot-like. New `POLL_BOT_THINK_DELAY_MS` used only in `runPollRound`: slower first response AND a wider spread between the three bots. OpenAI latency still hides inside the think delay (call fires immediately). Originally set 6–11s; hand-tuned down to **3–6s** after testing. Tune via the constant at the top of `server/index.js` (keep max + type-out under the 15s straggler grace).

Same day: **poll answer length mix retuned** — chance of the longer Variant B answer (yes/no + short reason) changed from 50% → **40%** via new `POLL_EXPLAIN_PROBABILITY` constant (`getBotResponse`); 60% now give the bare yes/no Variant A.

Same day: **pause between poll summary and next question** — the summary → "Moving on, …" pivot read as too quick (the next question's 3-5s think started the instant the summary posted). New `POLL_SUMMARY_TO_NEXT_PAUSE_MS = 1–2s` breather in `finishPollRound` before `advanceToNextRound`, so the full gap is now ~1-2s pause + 3-5s silent think + 3-5s typing. (Poll questions themselves keep the FIXED `EXPLANATORY_TYPING_DELAY_MS` 3-5s type-out regardless of length — the intentional "moderator pastes scripted questions" fast speed from item 1.)

### Message sent during a connection drop silently vanished — 2026-07-09 (FIXED)

**Symptom (own testing):** sent an answer, Eunice never responded, then the message disappeared from the chat "out of nowhere."

**Diagnosis (from the log):** typing packets stopped mid-typing at 12:32:51 — the polling transport died silently. The Send went into the dead socket and never reached the server (no `HUMAN_INPUT` line). The message stayed visible only because of the client's optimistic render. The typing watchdog fired at +8s, the server declared the socket dead at 12:33:13 (ping timeout), the client auto-reconnected and rejoined at 12:33:14 — and the rejoin `seed` REPLACES the client message list with the server's authoritative history, wiping the optimistic (never-delivered) message off the screen. Eunice's "silence" was just her waiting for an answer the server never received.

**Fix — resend-on-rejoin outbox (`ChatPage.jsx`):** `outboxRef` holds the text of every sent message until the server's echo confirms it (echo handler removes it; matching already existed for optimistic confirm). On `seed`: (1) dedup the outbox against the seed **tail (last 10)** — if the message IS in the server history, only the echo was lost, don't resend (tail-only so an identical short answer from an earlier round can't mask a real loss); (2) keep survivors visible as `_optimistic` entries appended after the seed; (3) re-emit each via `human_message` and arm the 4s idle timer so the flow advances. Outbox is cleared on the fresh-session paths (`participant_name`, `rejoin_failed`) — an expired session's unsent answer must not leak into a new session's intro. Double-send safety: socket.io v4 flushes its own send-buffer BEFORE the `connect` handler runs, so a buffered copy reaches the server while `session` is still null on the new socket and is dropped by the `if (!session) return` guard — our post-seed resend is the only one that lands.

### Funnel stage durations in participant_responses — 2026-07-08

Four INT (milliseconds) columns added to `participant_responses` (ALTER TABLE IF NOT EXISTS in the init block, same pattern as before) recording how long each funnel stage took. (First implemented as `ts_*` DATETIME checkpoints, then reworked same-day to durations per prof request — the ts_* columns never shipped; if the intermediate build ever ran against a DB, drop them manually.)

| Column | Duration measured | How |
|---|---|---|
| `dur_opening_ms` | App opened (consent page) → focus-group chat starts (consent + welcome + waiting room) | Client-side: `sessionStorage.openedAtMs` set at ConsentPage mount (NamePage fallback for direct `/welcome` hits; first visit wins, reloads don't reset), ChatPage sends `msSinceOpened = now − openedAtMs` with `participant_name`. Single clock → no skew. |
| `dur_focus_group_ms` | Chat start → chat end (wrap-up OR any of the 3 kicks: idle, unsubstantial, inappropriate; first end wins) | Server-side: `session.chatStartAt` stamped at `participant_name`, `session.chatEndAt` at the 4 end points; diff computed in `saveSessionToDatabase`, persisted with `COALESCE(existing, VALUES(...))` first-wins. |
| `dur_auth_selection_ms` | Password/passkey cards shown → **LAST** method-card click. Changing one's mind counts as still selecting: click passkey → click password → create password ⇒ selection ends at the *password* click. | Client-side in SecureStep: `shownAtRef` anchored when `topMethod` resolves (cards render); `lastClickAtRef` re-anchored on EVERY card click. Running value sent with each `log-auth-click` (latest overwrites, so abandoners keep shown→their-last-click); the registration request writes the final authoritative value on success. |
| `dur_auth_creation_ms` | Last method click → SUCCESSFUL registration. Same scenario ⇒ password click → account created. A failed passkey attempt followed by a re-click re-anchors to the newest click. | Client-side: `authCreationMs = now − lastClickAtRef` sent in the `register-password` / `webauthn-register-verify` bodies (alongside `authSelectionMs`); stored on the success UPDATE (`COALESCE(?, dur)` so a missing value never clobbers). |

Server sanitizes all client-reported durations via `sanitizeDurationMs()` (finite, ≥0, rounded, capped at INT max). NULL semantics are informative: `dur_focus_group_ms` NULL = abandoned mid-chat; `dur_auth_selection_ms`/`dur_auth_creation_ms` NULL = never reached/completed that stage. Total selection-screen→account time = `dur_auth_selection_ms + dur_auth_creation_ms`. Deploy: server → git pull + Plesk **Restart App** (runs the ALTERs); client → rebuild + scp `dist/`.

### Prolific completion codes for early exits (kicked / declined) — 2026-07-08

Kicked and consent-declined participants are now auto-returned to Prolific with distinct completion codes instead of being told to close the page:
- **Kicked** (any kick reason — idle/attention-check, unsubstantial, inappropriate/trolling): `https://app.prolific.com/submissions/complete?cc=CN7JBFL7`
- **Declined consent**: `https://app.prolific.com/submissions/complete?cc=C1M1NSHW`
- (Completed studies keep the existing `cc=CQVN22U3` via SurveyPage/CompletePage.)

Implementation: `ChatPage.jsx` `kicked` handler now navigates to `/?kicked=1` (was `/?declined=1`) after the blocking alert. `ConsentPage.jsx` end screen handles both `?kicked=1` and declined (query param or decline click): shows a 5-4-3-2-1 countdown ("Redirecting you back to Prolific in N…"), then `window.location.replace(exitUrl)`, with a manual "click here" fallback link. The kicked variant says "Your session has ended…" instead of "Since you did not agree to participate…". Reloading `/?kicked=1` just restarts the countdown, so the code still gets recorded. Client-side change — rebuild + scp `dist/` to deploy.

### Transcript header: session ID + Prolific PID — 2026-07-08

The per-session transcript txt header (written in the `participant_name` handler, `server/index.js`) now includes `Session ID:` and `Prolific PID:` lines after `Participant:`. The PID shows `(none)` for non-Prolific runs (direct hits, testing). Prolific params are stored on the session just before the header write, so both values are always available there. Server-side change — needs git pull + Plesk **Restart App** to go live.

### Full-code edge-case review + dead-code cleanup — 2026-07-08

**Cleanup applied (behavior-preserving only, verified with `node --check`, eslint, and a client build):**
- Deleted dead files: `client/src/ChatPage.jsx.temp` (stale pre-rewrite ChatPage copy), `client/src/App.css` (never imported), `client/src/assets/react.svg` (empty, unreferenced).
- `client/src/main.jsx`: removed unused `StrictMode` import.
- `client/src/ChatPage.jsx`: removed dead `socket.emit("end")` in `goLogin` — the server has no `"end"` handler.
- `server/prompts.js`: removed never-imported `pickRandomCast`, its now-orphaned `uniqByHandle`, and the unused `humanParticipantName`/`human` in `buildUserPrompt` (the human name is only used in `systemPrompt`).
- `server/index.js`: extracted `transcriptPathFor(session)` (the transcript path was built identically in `appendTranscriptLine` and the `participant_name` handler); reused `isHuman` and removed the dead `nextNameForLog` ternary in `advanceCallOn` (always the bot branch there); removed unused `disagreedByResolved` and merged the duplicate `disagreedByKey`/`disagreedByDisplay` in `runDisagreementPhase`; fixed stale comments (header idle timings said 3s/7s vs actual 4s/4s constants; `checkAndAnswerBotQuestion` docstring said "2 bubbles + re-ask"; CLI comment said "random cast").

**Edge cases found (items 1, 2, 6 fixed on 2026-07-08; the rest left as-is — decide per item):**
1. **NamePage camera-stream leak** (`requestCamera`). ✅ FIXED — 2026-07-08. The 5s timeout sets `settled` and shows the error; if the user answered the permission prompt *after* 5s, the granted stream was never stored in `streamRef` and never stopped → camera light stayed on with no UI (and no way to stop it — the unmount cleanup only stops `streamRef.current`) until the tab closed. Consequence if unfixed: a slow permission answer left the participant's webcam silently ON through the entire study (waiting room, chat, survey) — a serious perceived-privacy problem for a security-perception study, and clicking "Allow camera" again stacked a second live stream. Fix: in the `.then`, when `settled` is already true, stop the stream's tracks immediately.
2. **Stale "typing…" after rejoin** (`ChatPage`). ✅ FIXED — 2026-07-08. The `typing` state map was not reset in the `seed` handler; the old socket's `emitTyping(false)` died with the disconnected flow, so a bot/Eunice mid-typing at disconnect stayed "typing…" after reconnect until that same speaker happened to type again — for a bot that had just finished its turn, potentially the rest of the session. Consequence if unfixed: participant waits politely for a message that never comes, stops answering, idle nudges escalate, worst case they get kicked while "waiting for Sid to finish typing". Fix: `setTyping({})` at the top of the seed handler (fresh flows re-emit their own indicators after rejoin).
3. **Mina's canned passkey follow-up can write into the wrong poll**: ✅ Fixed as a side effect of the 2026-07-09 passkey-poll ordering rework — the stance is now written synchronously on the poll's own captured state inside `checkAndAnswerBotQuestion`'s deferred branch, so it can't land in a later poll.
4. **CLI fallback leaves `botIds`/`botIdMap` empty** (`createSession`): when CLI bot names match no personas, `bots` is refilled from the rotation cast but `botIds`/`botIdMap` keep the empty first-pass values (DB `bots_config` null; persona lookup falls back to handle). CLI-only path, never hit in production.
5. **`getBotResponse` prior-context boundary rarely matches**: `currentRoundMsgs` keys are `name:joined-round-text` (with the human aliased to the introduced name) but the loop compares per-message `name:text` keys from `session.messages` — the `break` mostly never fires, so current-round moderator lines can appear duplicated in the "Earlier discussion context" block. Prompt-quality only, no user-visible break.
6. **Missing nudge re-arm in one cancel path**. ✅ FIXED — 2026-07-08. The inline cancel branch in `runDisagreementPhase` (right after `detectDisagreements`) rolled back like `cancelAdvance` but did NOT call `startIdleNudgeTimer` — same gap the 2026-06-14 sweep fixed inside `cancelAdvance` itself. Consequence if unfixed: user types during the ~1-2s disagreement-detect call, then abandons (draft never sent, laptop closed, or the `human_idle` packet drops on the flaky polling transport) → server sits in `waitingForHumanIdle` with NO nudge timer → no nudge, no kick, permanent dead-air stall (normally the client's own `human_idle` timer recovers it, so this only bites when that signal never arrives). Fix: replaced the inline copy with the equivalent `cancelAdvance(session, …, { rollbackIndex: "prev", clearRound: true })` call, which performs the identical rollback AND re-arms the idle nudge timer.
7. **`runPollRound` bot promises use `new Promise(async (resolve) => …)`**: any throw not covered by the inner try/catches (e.g. inside `checkAndAnswerBotQuestion`) skips `resolve()` → that bot's promise hangs (straggler grace masks it). Antipattern; converting changes error propagation, so left as-is.
8. **Typo in the first-poll instructions in `startFirstRound`**: "please respond briefly:yes, no, …" (missing space/dash; the `advanceToNextRound` copy reads "briefly — yes"). Currently unreachable — round 1 is always a big question in both scripts — but will surface if the script order ever changes.
9. **Dev-only: registration endpoints 404 under `npm run dev`**: `LoginChoice`'s fetches use relative `/api/focus-group/...` and `vite.config.js` has no proxy to :3001 (ChatPage/NamePage use `SERVER_BASE` for dev; LoginChoice doesn't). Works in production (same origin).
10. **`capitalizeFirst` lowercases the rest of the name**: "McKenna" → "Mckenna" for the display/introduced name.
11. **Client `idleTypingMs` fallback mismatch**: ChatPage defaults to `?? 10000` while the server always sends 4000 — only matters for keystrokes before the `session` event lands.
12. **`navigate()` during render in `LoginChoice`**: the `chatCompleted` guard calls navigate in the render body (React dev warning; works). Standard fix is a `useEffect` guard like NamePage's.

### Moderator typing-indicator race (dead-air before next question) — 2026-07-06 (PARTIALLY FIXED — Fix B applied; Option A backlog)

**Symptom (from a pilot log):** during the passkey poll, after the poll summary Eunice took ~37s to post the next big question, and for that entire 37s **no "typing…" indicator showed** — the message just appeared out of nowhere. (Timeline: passkey explanation part posted `21:18:15`, big question posted `21:18:52`, with a bare `[TYPING] moderator false` at the start of the gap and no `true` in between.)

**Root cause — two concurrent "Eunice" flows share ONE typing indicator.** `emitTyping(MODERATOR_NAME, …)` is a bare on/off emit with no ref-counting (last writer wins). Every moderator message flips it (`emitModeratorLine`: `emitTyping(true)` → wait `typeDelay` → `emitTyping(false)`). In the passkey poll two independent async chains run at once, both toggling that same indicator:
- **Flow A** — the queued passkey explanation answering Mina's "wait what even is that" (`checkAndAnswerBotQuestion` ~2040, or the `human_message` primary path ~3261-3288).
- **Flow B** — the round advance posting the `big_question` (`advanceToNextRound`, emit at ~2393; reached from `finishPollRound` after the poll summary).

They interleave: Flow A's `emitTyping(false)` when it finishes its own message **turns the indicator OFF while Flow B is still mid-`typeDelay`** on the (long, ~47-word, human-paced) big question. Nothing re-asserts `true`, so the participant sees no "typing…" for the remaining ~37s. Two problems stacked: (1) no serialization — advance was allowed to start while the answer was still emitting; (2) no ref-count on the indicator — A's completion clears a signal B still "owns". Same race *family* as the "Moderator double-texts" and idle-nudge bugs (a shared signal / late-set flag across an `await`).

**Fix B applied (2026-07-06, `server/index.js` `finishPollRound`, ~2740):** the narrow, low-risk serialization. Before emitting the poll summary / advancing, wait for any in-flight passkey explanation to finish. Captured **before** `session.pollState = null` (line ~2759 nulls it, dropping the promise ref). Concretely: `const pendingPasskey = session.pollState.passkeyExplanationEmitPromise; if (pendingPasskey) { await Promise.race([pendingPasskey, delay(45000)]); if (!session || !session.pollState) return; }`. The `Promise.race([…, delay(45000)])` is a **defensive cap** so a never-resolved promise can't freeze the round (the passkey flow resolves its promise on every path incl. a 20s Mina-wait timeout, so 45s comfortably clears the worst case). **No deadlock risk:** the passkey flow doesn't depend on `finishPollRound`, so awaiting it here can't cycle. Chosen over Option A because pilot was imminent and not worth the risk.
- **Residual edge NOT covered by Fix B:** it only waits if the explanation has **already been claimed** (`passkeyExplanationEmitPromise` set) by the time `finishPollRound` runs. If the human answers + goes idle *before* Mina asks "what is passkey" (promise still null), the later explanation can still race the summary/next-question. Rare (Mina usually asks early), acceptable for the pilot, but real.

**Option A — the full fix (BACKLOG; do this if perfecting or branching to a new project).** Serialize ALL moderator emits through one per-session mutex (promise-chain lock) so Eunice can only ever type one message at a time — the philosophically correct model (one moderator, one message). This fixes the whole *class* of bug, not just the passkey case. But it's a **real refactor, not a drop-in**, with genuine hazards + behavior changes I mapped out:
  - **Hazard 1 — partial coverage:** the worst path (the hand-rolled passkey block ~3269-3288) does NOT call `emitModeratorLine`; it manually holds `emitTyping(true)` across a wait-for-Mina + 20s race + 2s. A lock on `emitModeratorLine` alone doesn't cover it — you must fold that delicate block into the same lock.
  - **Hazard 2 — deadlock:** the passkey flows already `await` each other's `passkeyExplanationEmitPromise` (~2035, ~3300). If the mutex is **coarse** (a flow holds the lock while awaiting another flow's locked emit), X waits for Y while holding the door Y needs → freeze. Only safe if the lock is strictly **per-`emitModeratorLine`-call** and every `await …EmitPromise` stays OUTSIDE a held lock.
  - **Unwanted behavior change 1 — slower:** flows that used to overlap (answer a question WHILE advancing) now run strictly back-to-back → longer total waits in those moments.
  - **Unwanted behavior change 2 — interrupted bursts:** rapid-fire multi-bubble sequences (intro ~2445, wrap-up ~2362-2366, poll setup ~2575-2579) rely on `consecutive`/`skipThinkDelay` running truly back-to-back. A single-queue could wedge an unrelated emit between them, breaking the rhythm → must enqueue each multi-bubble group **atomically**.
  - **Unwanted behavior change 3 — mistimed nudges:** an idle nudge (~1767) queued behind a long emit could fire stale/late.
  - Also needs: crash-safe chain (`.catch` so a thrown/cancelled item doesn't wedge the queue) and run-time re-checks of `cancelAdvanceFromIdle`/`cancelCheck` on dequeue.
  - **Alternative to A, if only the visual glitch matters:** ref-count the typing indicator (emit `false` only when the active-emit count hits 0). Band-aid — fixes the dead-air but still lets two messages type/post back-to-back from two flows. Not recommended as the real fix.

### Edge-case sweep — 2026-06-14

Big audit of chat-simulation algorithms; the original 18 edge cases + a separate halt audit were all addressed in one pass. Each fix is small and contained; no architecture changes.

**Real halts fixed:**
- **OpenAI hangs freezing call-on/disagreement rounds** — added a 25s `timeout` on the OpenAI client (`new OpenAI({apiKey, timeout: 25000})`). Default was 10min + 2 retries (~30min worst case). 25s clears the observed ~22s rate-limit tail; longer stalls throw and each caller's existing try/catch falls back to a default line.
- **Disconnect mid-`runBotTurn` / mid-`runStudyGoal` / mid-`advanceToNextRound` permanently halts the chat** — added `maybeResumeAfterRejoin()` to the `rejoin` handler. State is inferred from existing flags (no new state machine): if `pollState` is mid-flight → force-finish; disagreement queue mid-flight with bot next → `runNextDisagreementFollowUp`; `roundDone` with empty queue → re-run `runDisagreementPhase` (clearing `disagreementPhase` guard); `roundDone` with queue exhausted → `advanceToNextRound`; mid call-on with bot next → `runBotTurn` (or `advanceCallOn` if bot already partly spoke this round — checked via `roundTranscript` to avoid duplicate bubble emissions); `studyGoalStarted` but no round yet → `startFirstRound`; intro never completed → replay `runIntroWithTyping` (only if no bot has spoken yet, otherwise just re-arm `waitingForHumanIntro`).
- **`humanIsTyping=true` stuck on dropped polling packet** — added a server-side `HUMAN_TYPING_WATCHDOG_MS=8000` timer in the `human_typing` handler. Each `isTyping=true` (re)arms; explicit `isTyping=false` cancels; on disconnect the watchdog is cleared and `humanIsTyping` is forced false so a future rejoin can't inherit it.
- **`cancelAdvance` left the chat with no nudge timer running** — added `if (isWaitingForHuman(session)) startIdleNudgeTimer()` at the end of `cancelAdvance`. Previously `human_idle` cleared the timer before calling `advanceCallOn`; if user typing then triggered `cancelAdvance`, the timer never came back until the user paused for another `human_idle`.

**Stalls / data quality fixed:**
- **Bare-greeting nudge-counter reset** — `human_message` used to set `idleNudgeCount = 0` unconditionally on every received message. A user spamming "hi" every 15s never escalated past nudge 1 in intro. Now the counter is reset only at success points: after `evaluateHumanIntro` returns true, after the substantive check passes (big_question), after any non-question/non-inappropriate poll answer, and after a disagreement-followup reply.
- **Idle nudge fires after the user already responded** — the nudge timer awaits `generateNudgeMessage` (~1s) + `emitModeratorLine` (multi-second). Cancel-check used to be only `humanIsTyping`. Now it's `() => !session || humanIsTyping || !isWaitingForHuman(session)`, so if the user's response advanced the flow during the await, the nudge text never gets posted.
- **Disagreement `resolve()` hallucinations + name collisions** — `resolve()` now requires the candidate name to actually appear in `answersByPerson` (i.e., spoke this round). On a name collision between the human's introduced name and a bot's name, the human is preferred. The non-speaker swap path is also guarded with `orderIndex===999 → continue`.
- **Kicked sessions leaking in `activeSessions`** — all three kick paths (idle, unsubstantial, inappropriate) now `activeSessions.delete(session.sessionId)` before nulling `session`. The disconnect handler's TTL cleanup was being skipped because `session` was already null by the time the disconnect arrived, leaving sessions in memory indefinitely and theoretically rejoinable.
- **Client kept emitting `human_typing` / `human_idle` / `human_message` after `study_complete`** — added `studyCompleteRef`/`studyComplete` in `ChatPage.jsx`. The `study_complete` handler now clears local timers, sends one final `isTyping:false`, and disables the input. `handleInputChange` / `onSend` short-circuit when the ref is set. UI: input shows "Chat ended — click Exit Chat" placeholder and is disabled.

**Dead code removed:**
- `moderatorTypingIntroCue` and `userRepliedDuringIntroCue` were set nowhere (the intro-cue path was deleted on 2026-04-22) but a dead branch in `human_message` + an unused `emitModeratorLine.skipIfUserReplied` option remained. Removed all of it.

### Moderator double-texts the entire flow — 2026-05-29 (FIXED)

Symptom: from the study-goal segment onward, EVERY moderator (Eunice) message was sent twice (and two bots acked the study goal, two "first round" log lines). Root cause: the intro→study-goal transition is reachable from multiple handlers — `human_message` after intro (`index.js` ~2778), `human_idle` after intro (~2595), the intro-cue reply path (~2764), and `runIntroRound` (~2138). Each clears `waitingForHumanIntro` only AFTER an `await evaluateHumanIntro()` (OpenAI) call, so when the user sends their intro and then goes idle ~4s later, `human_idle` fires while `human_message`'s evaluate call is still in flight → both pass the `waitingForHumanIntro` guard and both call `runStudyGoal()`. Two concurrent `runStudyGoal()` → two parallel copies of the whole moderator flow (study goal → startFirstRound → call-on → …), so everything downstream is doubled too. **Fix:** one-shot guard at the top of `runStudyGoal()` — `if (!session || session.studyGoalStarted) return; session.studyGoalStarted = true;` (synchronous check-and-set, race-safe single-threaded; `studyGoalStarted` defaults falsy on the fresh per-session object). Same race family as the classify/nudge races below (guard flag set after an await). NOT touched: the idle-nudge race (nudge still posts if the user answers while a nudge is mid-generation) — separate, still open.

### Poll bots appear "cancelled" / take forever — 2026-05-29

Symptom from logs: in poll rounds, a bot's typing indicator turned off, then the message appeared 30–50s later (e.g. Sid: typing-false at 06:33:41, OPENAI_OK at 06:34:32). The poll summary is gated on `Promise.all(botPromises)`, so the human who answered stares at a dead screen until the slowest bot returns.

Root cause #1 (UX): `runPollRound` did `emitTyping(true) → short fixed delay → emitTyping(false) → getBotResponse() → emitMessage`. The OpenAI call happened AFTER typing was turned off, so during a slow completion there was no indicator → looks frozen/cancelled. **Fix:** reordered to `emitTyping(true) → getBotResponse() (typing stays on the whole time) → short type-out delay for the actual answer → emitTyping(false) → emitMessage`. Responses were never actually cancelled.

Root cause #2 (latency, instrumented not fixed): In the round-2 log, between `human_idle` (06:34:02) and Sid's `OPENAI_OK` (06:34:32) there are ZERO log lines — the Node event loop is idle, waiting on exactly one thing: Sid's in-flight `getBotResponse` HTTP call (started ~06:33:42, so ~50s). So the 50s is the HTTP call itself, not our code doing extra work. Why only in polls (call-on is fast)? The poll flow's LOGIC fans out a burst of concurrent OpenAI calls — 3 bot completions + 3 `checkAndAnswerBotQuestion`→`classifyHumanMessage` (2 calls each) + the human's own classify — all within seconds, vs call-on which is strictly sequential (≤2 in flight). A burst that exceeds the account's RPM/TPM → 429 → SDK silent retry-with-backoff (client is bare `new OpenAI({apiKey})`, default 10-min timeout / 2 retries) stretches one call to tens of seconds. The poll ALSO blocks the summary on `Promise.all` of all bots, so one straggler freezes the human. Added `OPENAI_REQ` + `rtt=` logging to the poll path (matching `runBotTurn`) to confirm on next run. Final poll-bot timing model (2026-05-29): exactly TWO delays per bot — (1) **thinking delay** (`thinkMs` 3–5s, SILENT, no indicator; the OpenAI call runs concurrently inside it) and (2) **typing delay** (`typingDelayMs(answer)`, full length, "typing…" indicator shown for the ENTIRE duration). Implementation: fire `getBotResponse` immediately (all bots at once) before the thinking `delay`, `await` the promise after it (so API latency hides inside thinking, not stacked). **Stagger removed 2026-05-29** — a log showed Anthony's call fire *solo* (Sid/Mina already returned) and still take 36274ms, proving the 20–36s tails are per-minute rate-limit retries (429 → SDK honors `Retry-After` ~30s) not instant concurrency; the stagger only added latency for no gain. Real fix for the tails is the OpenAI tier (RPM/TPM) or cutting per-minute call volume (e.g. the per-bot `classifyHumanMessage` question-check = 2 calls/bot). KEY REQUIREMENT from user: the typing delay is NOT capped — whatever `typingDelayMs` returns (e.g. 5.2s for a 5-word answer) the indicator shows for that whole time. No "hidden" delay: every bit of waiting before the message is either silent-thinking (acceptable) or shown-as-typing; there must be no stretch where the bot is delayed but NOT showing "typing…". (Briefly added a `POLL_MAX_TYPING_MS=2000` cap — REMOVED, that was the opposite of what the user wanted.)

rtt data (session 2026-05-29 11:5x, ran the pre-decouple build): OpenAI rtt is wildly variable even for SHORT outputs and even for SOLO calls — Anthony's VPN poll call fired alone (Sid/Mina already done) and took **22182ms** for "I've used VPN a few times"; others 11039ms, 12755ms; a call-on call hit **32151ms**. Not concurrency, not output length → it's OpenAI-account-side (per-minute 429 → SDK silent retry-backoff, likely low tier). Code can't speed up a 22s API call; the grace timer caps the hang and the silent-think keeps it off the typing indicator. ALSO confirmed the visible "typing too long" was mostly `typingDelayMs` (~1 word/sec → 5.2s for a 5-word poll answer), not the API. Added `POLL_MAX_TYPING_MS=2000` cap on poll type-out. Recommend checking the OpenAI usage tier / RPM-TPM limits — that's the real lever for overall poll speed.

Fixes applied 2026-05-29: (a) **stagger** — poll bots think for `randomBetween(3000,5000) + idx*POLL_STAGGER_MS(1500)`, so getBotResponse calls fire in a wave instead of one simultaneous burst, keeping concurrent OpenAI calls low. (b) **straggler grace** — `pollState` gained `finished`/`graceTimer`; on `human_idle` we set `humanFinished`, call `startPollStragglerGrace()` (a `POLL_STRAGGLER_GRACE_MS=15000` timer) and `maybeFinishPollRound()`. Round finishes when human-done AND (bots-done OR grace elapsed), so one stuck bot can't freeze the participant. `finishPollRound` idempotent (`finished` guard + clears timer); a straggler resolving after `finished` is suppressed (checks captured `pollState.finished`) so no stale answer leaks into the next round. (c) **typing term decoupled from latency** — the bot now fetches its answer during the SILENT think phase (no indicator), then shows "typing…" only for `typingDelayMs(answer)` (≈1s for "yes", ≈3–4s for a sentence). Previously the indicator was on for the whole OpenAI call, so a slow call made a 1-word answer "type" for 30–50s. OpenAI latency is now invisible (absorbed into think time, capped by the grace timer). Poll path also logs `OPENAI_REQ`/`rtt=`. Did NOT touch retries/timeout on the OpenAI client.

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
   - **No auto-redirect (2026-05-29):** On successful finish, the `study_complete` handler in `ChatPage.jsx` previously did `setTimeout(() => navigate("/login"), 3000)`. Removed — the participant must now click "Exit Chat" themselves (matches the moderator's "click the End Chat button" message).
   - **Kicked → declined-consent screen (2026-05-29):** `socket.on("kicked")` uses a blocking native `alert()`, so navigation waits until the participant dismisses the popup. It now navigates to `/?declined=1` (was `/survey`) so the kicked participant lands on the same "you will not proceed, please close this page" screen shown when consent is declined. `ConsentPage.jsx` initializes its `declined` state from the `?declined=1` query param.
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
