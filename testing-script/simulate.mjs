#!/usr/bin/env node
/**
 * Study simulation script.
 * Usage: node simulate.mjs [numSessions]
 * Example: node simulate.mjs 2    — runs 2 sessions in parallel
 */

import { io } from "socket.io-client";

const SERVER = "https://focusgroup.cc.gatech.edu";
const NUM_SESSIONS = parseInt(process.argv[2] || "1", 10);

// Predefined answers keyed by pattern-matching on the moderator's message
const ANSWERS = [
  { match: /introduce|intro/i,                                         text: "Hi! My name is Hailey. Nice to meet you all!" },
  { match: /new features|roll out|introduces something/i,              text: "I tend to adopt new technology right away. I am always very excited to try new stuff." },
  { match: /VPN/i,                                                     text: "Yes" },
  { match: /password manager/i,                                        text: "Yes" },
  { match: /generative AI|ChatGPT|Gemini|Copilot/i,                    text: "I use chat gpt everyday for my work. it makes be much of my work easier and streamlined" },
  { match: /heard about passkey|switch.*passkey|login.*passkey|used it|what made you|held you back/i, text: "I use it whenever it is available. I love how it simplifies log in process and I don't even need to remember password anymore." },
  { match: /passkey/i,                                                 text: "Yes" },
  { match: /elaborate/i,                                               text: null }, // will use lastAnswer
];

// Fallback if no match
const FALLBACK_ANSWER = "I think that's interesting. I'm generally open to trying new things.";

function findAnswer(moderatorText) {
  for (const a of ANSWERS) {
    if (a.match.test(moderatorText)) return a.text;
  }
  return FALLBACK_ANSWER;
}

function log(sessionNum, phase, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [S${sessionNum}] [${phase}] ${msg}`);
}

async function simulateTypingAndSend(socket, text, sessionNum) {
  socket.emit("human_typing", { isTyping: true, hasDraft: true });
  socket.emit("human_message", { text });
  log(sessionNum, "SENT", `"${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
  socket.emit("human_typing", { isTyping: false, hasDraft: false });
  socket.emit("human_idle");
  log(sessionNum, "IDLE", "sent human_idle");
}

function runSession(sessionNum) {
  return new Promise((resolve) => {
    log(sessionNum, "CONNECT", `Connecting to ${SERVER}...`);

    const socket = io(SERVER, {
      autoConnect: false,
      path: "/socket.io",
      transports: ["polling"],
    });

    let sessionData = null;
    let currentQuestion = "";   // track the latest moderator question/prompt
    let responded = new Set();  // track which questions we already responded to
    let waitingToRespond = false;
    let lastAnswer = "";        // track last answer for elaborate requests
    let done = false;

    socket.on("connect", () => {
      log(sessionNum, "CONNECT", "Connected, sending participant_name");
      socket.emit("participant_name", { name: `Hailey${NUM_SESSIONS > 1 ? sessionNum : ""}` });
    });

    socket.on("session", (data) => {
      sessionData = data;
      log(sessionNum, "SESSION", `sessionId=${data.sessionId} group=${data.assignedGroup || "?"} bots=[${(data.bots || []).join(", ")}]`);
    });

    socket.on("seed", (msgs) => {
      log(sessionNum, "SEED", `${msgs.length} messages`);
    });

    socket.on("message", async ({ name, text }) => {
      const short = text.slice(0, 80).replace(/\n/g, " ");
      log(sessionNum, "MSG", `[${name}] ${short}${text.length > 80 ? "..." : ""}`);

      // Only respond to moderator messages directed at us
      if (name !== "Eunice") return;
      if (done) return;

      const myName = `Hailey${NUM_SESSIONS > 1 ? sessionNum : ""}`;
      const mentionsMe = text.includes(`@${myName}`) || text.toLowerCase().includes(myName.toLowerCase());
      const isGeneralPrompt = /introduce|introductions|how about you/i.test(text);
      const isQuestion = /\?|how do you|have you|what made you|what held/i.test(text);

      // Track what the current topic is (big questions, polls, intro prompts)
      if (isQuestion || isGeneralPrompt || text.length > 60) {
        currentQuestion = text;
      }

      // Handle "elaborate" — resend last answer with more detail
      const isElaborate = /elaborate/i.test(text);
      if (isElaborate && mentionsMe || isElaborate) {
        waitingToRespond = true;
        const elaboration = lastAnswer || findAnswer(currentQuestion) || FALLBACK_ANSWER;
        await simulateTypingAndSend(socket, elaboration, sessionNum);
        waitingToRespond = false;
        return;
      }

      // Respond if we're mentioned or it's a general intro prompt we haven't answered
      const shouldRespond = mentionsMe || (isGeneralPrompt && !responded.has("intro"));

      if (shouldRespond && !waitingToRespond) {
        const key = currentQuestion || text;
        if (responded.has(key)) return;
        responded.add(key);
        if (isGeneralPrompt) responded.add("intro");

        waitingToRespond = true;
        const answer = findAnswer(text + " " + currentQuestion);
        lastAnswer = answer;
        await simulateTypingAndSend(socket, answer, sessionNum);
        waitingToRespond = false;
      }
    });

    socket.on("typing", ({ who, isTyping }) => {
      if (isTyping) {
        log(sessionNum, "TYPING", `${who} is typing...`);
      }
    });

    socket.on("kicked", ({ reason, message } = {}) => {
      log(sessionNum, "KICKED", `reason=${reason} message="${message}"`);
      done = true;
      socket.disconnect();
      resolve({ sessionNum, result: "kicked", reason });
    });

    socket.on("study_complete", ({ sessionId, participantId } = {}) => {
      log(sessionNum, "COMPLETE", `Study complete! sessionId=${sessionId} participantId=${participantId}`);
      done = true;
      socket.disconnect();
      resolve({ sessionNum, result: "complete", sessionId });
    });

    socket.on("disconnect", (reason) => {
      log(sessionNum, "DISCONNECT", reason);
      if (!done) {
        done = true;
        resolve({ sessionNum, result: "disconnected", reason });
      }
    });

    socket.on("connect_error", (err) => {
      log(sessionNum, "ERROR", err.message);
    });

    // Timeout: if study takes more than 15 minutes, bail
    setTimeout(() => {
      if (!done) {
        log(sessionNum, "TIMEOUT", "15 min timeout reached, disconnecting");
        done = true;
        socket.disconnect();
        resolve({ sessionNum, result: "timeout" });
      }
    }, 15 * 60 * 1000);

    socket.connect();
  });
}

// --- Main ---
console.log(`\n=== Starting ${NUM_SESSIONS} session(s) against ${SERVER} ===\n`);

const sessions = [];
for (let i = 1; i <= NUM_SESSIONS; i++) {
  sessions.push(runSession(i));
}

const results = await Promise.all(sessions);

console.log("\n=== Results ===");
for (const r of results) {
  console.log(`  Session ${r.sessionNum}: ${r.result}${r.reason ? ` (${r.reason})` : ""}`);
}
process.exit(0);
