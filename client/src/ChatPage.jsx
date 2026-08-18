import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import "./ChatPage.css";
import {
  MainContainer,
  MessageList,
  Message,
  MessageInput,
} from "@chatscope/chat-ui-kit-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";

const PARTICIPANT_NAME_KEY = "participantName";
const PARTICIPANT_PROFILE_KEY = "participantProfilePicture";
const SERVER_BASE = import.meta.env.DEV ? "http://127.0.0.1:3001" : "";

// TESTING TOGGLE — Exit Chat button visibility.
//   false (production): the button only appears once Eunice wraps up and
//     `study_complete` fires, so participants can't skip the focus group.
//   true (testing): the button is always visible so you can jump to the
//     login/survey flow without sitting through the whole chat.
// ⚠️ Must be false before launching the pilot.
const SHOW_EXIT_BUTTON_ALWAYS = true;

// Bots that use one of the reserved participant-style photos instead of their own
// named PNG. profile_8.jpg / profile_9.jpg are excluded from the user picker
// (NamePage PRESET_POOL) so a participant can't share an avatar with these bots.
const RESERVED_BOT_AVATARS = { Mina: "profile_8.jpg", Sid: "profile_9.jpg" };

function fmtTime(ts) {
  try {
    return new Date(ts || Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Bubble colors per person (light tints)
const SENDER_COLORS = [
  "#e3f2fd", // light blue – You
  "#f3e5f5", // light purple
  "#e8f5e9", // light green
  "#fff3e0", // light orange
  "#fce4ec", // light pink
  "#e0f7fa", // light cyan
  "#f1f8e9", // light lime
  "#ede7f6", // light indigo
];

// Moderator: blue so it reads as mod
const MODERATOR_COLOR = "#bbdefb"; // light blue
const MODERATOR_LABEL = " (mod)";

// One color per slot: You, Mod, then bots — no repeat until palette is exhausted
const PARTICIPANT_PALETTE = [SENDER_COLORS[0], MODERATOR_COLOR, ...SENDER_COLORS.slice(1)];

function getOrderedParticipantNames(session, myName) {
  const names = [myName || "You"];
  if (session?.moderatorName) names.push(session.moderatorName);
  if (session?.bots?.length) names.push(...session.bots);
  return names;
}

function isSelf(sender, myName) {
  const s = String(sender || "").toLowerCase();
  if (myName && s === String(myName).toLowerCase()) return true;
  return false;
}

// Compact label of how the participant set their profile picture on the welcome
// page, recorded in the DB: "camera" (took a photo), "profile_N" (picked preset
// avatar N), or "none". Camera captures are stored as data: URLs; presets as
// /profile_pictures/profile_N.jpg URLs.
function getProfilePicChoice() {
  try {
    const pfp = sessionStorage.getItem(PARTICIPANT_PROFILE_KEY) || "";
    if (!pfp) return "none";
    if (pfp.startsWith("data:")) return "camera";
    const m = pfp.match(/profile_(\d+)\.jpg/);
    return m ? `profile_${m[1]}` : "preset";
  } catch {
    return "none";
  }
}

function getColorForSender(sender, session, myName) {
  if (!sender) return PARTICIPANT_PALETTE[0];
  if (isSelf(sender, myName)) return PARTICIPANT_PALETTE[0];
  const ordered = getOrderedParticipantNames(session, myName);
  const i = ordered.indexOf(sender);
  if (i >= 0) return PARTICIPANT_PALETTE[i % PARTICIPANT_PALETTE.length];
  let h = 0;
  for (let j = 0; j < String(sender).length; j++) h = (h << 5) - h + String(sender).charCodeAt(j);
  return PARTICIPANT_PALETTE[Math.abs(h) % PARTICIPANT_PALETTE.length];
}

// Darken a hex color by a factor (0 = black, 1 = unchanged)
function darkenHex(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return "#" + [r, g, b].map(c =>
    Math.max(0, Math.round(c * factor)).toString(16).padStart(2, "0")
  ).join("");
}

// Render message text with @Name mentions styled as colored chips.
// Returns plain string if no mentions found, or an array of React elements.
function renderWithMentions(text, session, myName) {
  if (!text || !session) return text;
  const names = getOrderedParticipantNames(session, myName);
  if (!names.length) return text;
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`@(${escaped.join("|")})(?!\\w)`, "gi");
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const matchedName = match[1];
    const canonical = names.find(n => n.toLowerCase() === matchedName.toLowerCase()) || matchedName;
    const bubbleColor = getColorForSender(canonical, session, myName);
    const darkColor = darkenHex(bubbleColor, 0.45);
    parts.push(
      <span key={match.index} style={{
        fontWeight: 700,
        color: darkColor,
        backgroundColor: bubbleColor + "80",
        borderRadius: 4,
        padding: "1px 4px",
      }}>
        @{canonical}
      </span>
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

// Build participant list for sidebar: You, Moderator, Bots (with profile pic + color, no repeat)
function getParticipants(session, participantName) {
  const list = [];
  const myName = participantName || "You";
  const bots = session?.bots || [];
  const moderatorName = session?.moderatorName;

  list.push({
    name: myName,
    displayName: myName,
    isYou: true,
    isModerator: false,
    color: PARTICIPANT_PALETTE[0],
    profilePic: null, // set from sessionStorage in component
  });
  let paletteIndex = 1;
  if (moderatorName) {
    list.push({
      name: moderatorName,
      displayName: `${moderatorName}${MODERATOR_LABEL}`,
      isYou: false,
      isModerator: true,
      color: PARTICIPANT_PALETTE[1],
      profilePic: `${SERVER_BASE}/profile_pictures/${moderatorName}.png`,
    });
    paletteIndex = 2;
  }
  bots.forEach((bot, i) => {
    list.push({
      name: bot,
      displayName: bot,
      isYou: false,
      isModerator: false,
      color: PARTICIPANT_PALETTE[(paletteIndex + i) % PARTICIPANT_PALETTE.length],
      profilePic: `${SERVER_BASE}/profile_pictures/${RESERVED_BOT_AVATARS[bot] || `${bot}.png`}`,
    });
  });
  return list;
}

export default function ChatPage() {
  const navigate = useNavigate();
  const participantName = useMemo(() => {
    try {
      return (sessionStorage.getItem(PARTICIPANT_NAME_KEY) || "").trim() || null;
    } catch {
      return null;
    }
  }, []);

  const socket = useMemo(
    () =>
      io(SERVER_BASE || undefined, {
        autoConnect: false,
        path: "/socket.io",
        transports: ["polling"],
        // Don't let socket.io close the connection on `beforeunload`. Our reload/close
        // warning fires beforeunload; if the participant cancels (stays), the default
        // closeOnBeforeunload=true would have already killed the socket and the chat
        // freezes. Keeping it open lets the chat run normally after they dismiss.
        closeOnBeforeunload: false,
        ...(import.meta.env.DEV && { withCredentials: true }),
      }),
    []
  );

  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState({});
  const [session, setSession] = useState(null);
  const [input, setInput] = useState("");
  // Once the moderator sends `study_complete`, lock the input and stop emitting
  // typing/idle/message events so post-study keystrokes don't leak into the transcript.
  const studyCompleteRef = useRef(false);
  const [studyComplete, setStudyComplete] = useState(false);
  // Notification sounds
  const tabFocusedRef = useRef(document.hasFocus());
  const sndFocusRef = useRef(new Audio("/new_message_on_focus.mp3"));
  const sndOutRef = useRef(new Audio("/new_message_outoffocus.mp3"));

  useEffect(() => {
    const onFocus = () => { tabFocusedRef.current = true; };
    const onBlur = () => { tabFocusedRef.current = false; };
    const onVis = () => {
      if (document.visibilityState === "hidden") tabFocusedRef.current = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Mobile keyboard handling. iOS Safari ignores `overflow: hidden` on html/body when
  // an input is focused — it auto-scrolls the document to bring the input into view,
  // and CSS `height: var(--app-h)` doesn't always win against the browser's own layout.
  // So we force the layout into the visual viewport with INLINE styles on html/body/#root
  // (inline beats any CSS), pin #root with position: fixed at vv.offsetTop, and snap
  // window.scroll back to 0 whenever iOS tries to move it. This eliminates the long
  // scroll + white space below the chat when the keyboard appears.
  useEffect(() => {
    document.documentElement.classList.add("chat-active");
    const vv = window.visualViewport;
    const rootEl = document.getElementById("root");
    let raf = 0;
    const update = () => {
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      const html = document.documentElement;
      // Classic scroll-lock: pin html/body with position:fixed + overflow:hidden so
      // the document itself has no scrollable area. iOS Safari ignores overflow:hidden
      // alone on focused inputs, but a fixed, fully-pinned html+body it must respect.
      html.style.height = `${h}px`;
      html.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = "0";
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.height = `${h}px`;
      document.body.style.overflow = "hidden";
      if (rootEl) {
        rootEl.style.position = "fixed";
        rootEl.style.top = `${top}px`;
        rootEl.style.left = "0";
        rootEl.style.right = "0";
        rootEl.style.height = `${h}px`;
        rootEl.style.display = "flex";
        rootEl.style.flexDirection = "column";
        rootEl.style.overflow = "hidden";
      }
      const headerEl = document.querySelector(".site-header");
      const headerH = headerEl ? headerEl.getBoundingClientRect().height : 0;
      html.style.setProperty("--header-h", `${headerH}px`);
      html.style.setProperty("--app-h", `${h}px`);
      // Undo iOS auto-scroll: any non-zero document scroll means iOS shifted us.
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
      // Keyboard-up: hide the Exit footer and drop bottom padding so the input
      // sits flush against the keyboard (no white space stripe below it).
      const kbOpen = !!vv && h < window.innerHeight - 100;
      html.classList.toggle("kb-open", kbOpen);
      // Force scroll-to-bottom only on small screens.
      if (window.matchMedia("(max-width: 700px)").matches) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const list = document.querySelector(".cs-message-list__scroll-wrapper");
          if (list) list.scrollTop = list.scrollHeight;
        });
      }
    };
    update();
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("resize", update);
    const onScroll = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll);
      const html = document.documentElement;
      html.style.height = "";
      html.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.height = "";
      document.body.style.overflow = "";
      if (rootEl) {
        rootEl.style.position = "";
        rootEl.style.top = "";
        rootEl.style.left = "";
        rootEl.style.right = "";
        rootEl.style.height = "";
        rootEl.style.display = "";
        rootEl.style.flexDirection = "";
        rootEl.style.overflow = "";
      }
      html.style.removeProperty("--app-h");
      html.style.removeProperty("--header-h");
      html.classList.remove("chat-active");
      html.classList.remove("kb-open");
    };
  }, []);

  // Debounce: stop-typing after 800ms; then idle = session.idleEmptyMs (empty) or session.idleTypingMs (has text)
  const typingTimeoutRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const inputRef = useRef("");
  // Outbox: text of sent messages the server hasn't echoed back yet. If the
  // connection dies mid-send, the server never receives the message and the
  // rejoin seed would silently wipe its optimistic copy off the screen — so
  // after each seed we re-send whatever is still unconfirmed (deduped against
  // the seed in case only the echo was lost).
  const outboxRef = useRef([]);

  // Back button and reload/close are handled globally by App.jsx's AccessGuard: back
  // routes to the blocked page, and reload shows the warning then the blocked page
  // (a reloaded chat never re-mounts, so it can't try to rejoin a stale session).
  // Transient socket drops that don't reload the page still auto-reconnect below.

  useEffect(() => {
    if (!participantName || !sessionStorage.getItem("passedWaiting") || sessionStorage.getItem("chatCompleted")) {
      navigate("/", { replace: true });
      return;
    }

    socket.on("connect", () => {
      console.log("connected", socket.id);
      const existingSessionId = sessionStorage.getItem("studySessionId");
      if (existingSessionId) {
        console.log("attempting rejoin", existingSessionId);
        socket.emit("rejoin", { sessionId: existingSessionId });
      } else {
        // Fresh session — unsent answers from a previous session don't apply.
        outboxRef.current = [];
        // Opening duration: how long from opening the app (consent page) to
        // reaching the chat — computed here on the client's own clock.
        const openedAtMs = Number(sessionStorage.getItem("openedAtMs"));
        socket.emit("participant_name", {
          name: participantName,
          prolificPid: sessionStorage.getItem("PROLIFIC_PID") || undefined,
          studyId: sessionStorage.getItem("STUDY_ID") || undefined,
          prolificSessionId: sessionStorage.getItem("PROLIFIC_SESSION_ID") || undefined,
          msSinceOpened: openedAtMs > 0 ? Date.now() - openedAtMs : undefined,
          profilePicChoice: getProfilePicChoice(),
        });
      }
    });
    socket.on("connect_error", (err) => console.log("connect_error", err));

    socket.on("rejoin_failed", () => {
      console.log("rejoin failed, starting new session");
      sessionStorage.removeItem("studySessionId");
      // Fresh session — unsent answers from the expired session don't apply.
      outboxRef.current = [];
      const openedAtMs = Number(sessionStorage.getItem("openedAtMs"));
      socket.emit("participant_name", {
        name: participantName,
        prolificPid: sessionStorage.getItem("PROLIFIC_PID") || undefined,
        studyId: sessionStorage.getItem("STUDY_ID") || undefined,
        prolificSessionId: sessionStorage.getItem("PROLIFIC_SESSION_ID") || undefined,
        msSinceOpened: openedAtMs > 0 ? Date.now() - openedAtMs : undefined,
        profilePicChoice: getProfilePicChoice(),
      });
    });

    socket.on("session", (s) => {
      setSession(s);
      if (s?.sessionId) sessionStorage.setItem("studySessionId", s.sessionId);
      // Blinded group code, available from session start so SurveyPage can
      // forward it to Qualtrics even after an early (testing) exit.
      if (s?.ag) sessionStorage.setItem("ag", s.ag);
    });

    socket.on("seed", (seedMsgs) => {
      // Drop typing indicators carried over from before a disconnect. The server
      // flow that turned one on died with the old socket, so its `isTyping: false`
      // never arrives — without this reset, "X typing…" can stick for the rest of
      // the session after a reconnect.
      setTyping({});
      // On rejoin, replace messages instead of appending. Compute direction per
      // message — hard-coding "incoming" makes the participant's own prior messages
      // render on the bot side after every reconnect.
      const seeded = (Array.isArray(seedMsgs) ? seedMsgs : []).map((m) => {
        const sender = m?.name ?? "";
        const isOutgoing = isSelf(sender, participantName);
        return {
          sender,
          message: typeof m?.text === "string" ? m.text : String(m?.text ?? "").slice(0, 2000),
          direction: isOutgoing ? "outgoing" : "incoming",
          ts: m?.ts,
        };
      });
      // Outbox messages that appear in the server's history were delivered after
      // all (only the echo was lost) — drop those. Match against the tail only,
      // so an identical short answer from an earlier round can't mask a real loss.
      const tail = seeded.slice(-10);
      outboxRef.current = outboxRef.current.filter(
        (text) => !tail.some((s) => s.direction === "outgoing" && s.message === text)
      );
      const pending = [...outboxRef.current];
      setMessages([
        ...seeded,
        // Keep unconfirmed messages visible (still _optimistic — the echo of the
        // re-send below will confirm them with the authoritative ts).
        ...pending.map((text) => ({
          sender: participantName || "",
          message: text,
          direction: "outgoing",
          ts: Date.now(),
          _optimistic: true,
        })),
      ]);
      // Re-send what the dead connection swallowed, then arm the idle timer so
      // the moderator flow advances once the resent answer lands.
      if (pending.length && !studyCompleteRef.current) {
        console.log("resending", pending.length, "unconfirmed message(s) after rejoin");
        for (const text of pending) socket.emit("human_message", { text });
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = setTimeout(() => {
          socket.emit("human_idle");
          idleTimeoutRef.current = null;
        }, 4000); // server's IDLE_EMPTY_MS default (session state isn't in this closure)
      }
    });

    socket.on("message", (m) => {
      const text = typeof m?.text === "string" ? m.text : String(m?.text ?? "").slice(0, 2000);
      const sender = m?.name ?? "";
      const isOutgoing = isSelf(sender, participantName);
      // Server echoed our message back — it's delivered, clear it from the outbox.
      if (isOutgoing) {
        const obIdx = outboxRef.current.indexOf(text);
        if (obIdx >= 0) outboxRef.current.splice(obIdx, 1);
      }
      setMessages((prev) => {
        if (isOutgoing) {
          // Find the first matching optimistic entry and confirm it with the
          // server's authoritative ts. Case-insensitive sender match because the
          // optimistic copy uses participantName (raw) while the server echo uses
          // humanDisplayName (capitalized).
          const idx = prev.findIndex(
            (p) =>
              p._optimistic &&
              p.message === text &&
              (p.sender || "").toLowerCase() === sender.toLowerCase()
          );
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { sender, message: text, direction: "outgoing", ts: m?.ts };
            return next;
          }
        }
        return [
          ...prev,
          {
            sender,
            message: text,
            direction: isOutgoing ? "outgoing" : "incoming",
            ts: m?.ts,
          },
        ];
      });
      // Play notification sound for incoming messages
      if (!isOutgoing) {
        const snd = tabFocusedRef.current ? sndFocusRef.current : sndOutRef.current;
        snd.currentTime = 0;
        snd.play().catch(() => {});
      }
    });

    socket.on("typing", ({ who, isTyping }) => {
      setTyping((prev) => ({ ...prev, [who]: isTyping }));
    });

    socket.on("kicked", ({ message } = {}) => {
      socket.disconnect();
      alert(message || "You have been removed from the session.");
      sessionStorage.setItem("chatCompleted", sessionStorage.getItem("studySessionId") || "1");
      // Locks this tab out of the funnel: ConsentPage always shows the kicked
      // end screen and NamePage refuses entry, so back-button / typing /welcome
      // can't restart the study after a kick.
      sessionStorage.setItem("studyEnded", "kicked");
      // ?kicked=1 (vs ?declined=1) so ConsentPage's end screen redirects to the
      // kicked/attention-check Prolific completion code, not the no-consent one.
      navigate("/?kicked=1", { replace: true });
    });

    socket.on("study_complete", ({ sessionId, participantId, ag } = {}) => {
      if (sessionId) localStorage.setItem("sessionId", sessionId);
      if (participantId) localStorage.setItem("participantId", participantId);
      // ag = blinded group code (server-side mapping), forwarded to Qualtrics by SurveyPage.
      if (ag) sessionStorage.setItem("ag", ag);
      sessionStorage.setItem("chatCompleted", sessionId || "1");
      // Lock the input: any further typing must not leak into the server transcript.
      studyCompleteRef.current = true;
      setStudyComplete(true);
      if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null; }
      if (idleTimeoutRef.current) { clearTimeout(idleTimeoutRef.current); idleTimeoutRef.current = null; }
      try { socket.emit("human_typing", { isTyping: false, hasDraft: false }); } catch { /* socket may be closed */ }
      // No auto-redirect: the participant must click the "Exit Chat" button to proceed.
    });

    socket.connect();

    return () => {
      // ✅ ensure server doesn't think you're typing forever
      try {
        socket.emit("human_typing", { isTyping: false, hasDraft: false });
      } catch {
        /* ignore on cleanup */
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      socket.disconnect();
    };
  }, [socket, participantName, navigate]);

  const typingText = Object.entries(typing)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  // Fires on every keystroke. chatscope passes (innerHtml, textContent, ...):
  // innerHtml feeds the contenteditable back (display), but draft detection must
  // use textContent — pasted rich text makes innerHtml non-empty markup.
  function handleInputChange(val, textContent) {
    if (studyCompleteRef.current) return; // study over — don't emit anything
    setInput(val);
    inputRef.current = textContent ?? val ?? "";
    const hasDraft = String(textContent ?? "").trim().length > 0;

    socket.emit("human_typing", { isTyping: true, hasDraft });

    // Typing debounce: stop "typing" after 800ms
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      const stillHasDraft = String(inputRef.current ?? "").trim().length > 0;
      socket.emit("human_typing", { isTyping: false, hasDraft: stillHasDraft });
      typingTimeoutRef.current = null;
    }, 800);

    // Idle: use server timings so we don't fire human_idle while user might still be typing
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    const isEmpty = String(val ?? "").trim() === "";
    const idleEmptyMs = session?.idleEmptyMs ?? 4000;
    const idleTypingMs = session?.idleTypingMs ?? 10000;
    const idleMs = isEmpty ? idleEmptyMs : idleTypingMs;
    idleTimeoutRef.current = setTimeout(() => {
      socket.emit("human_idle");
      idleTimeoutRef.current = null;
    }, idleMs);
  }

  // Called with PLAIN TEXT (innerText/textContent — see the MessageInput wiring
  // below). Never pass chatscope's first callback arg here: it's innerHTML, and
  // pasted rich text would send raw <span style=…> markup into the transcript,
  // DB, and LLM prompts.
  function onSend(text) {
    if (studyCompleteRef.current) return; // study over — don't send post-study messages
    const t = (text || "").replace(/\u00a0/g, " ").trim();
    if (!t) return;

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
    socket.emit("human_typing", { isTyping: false, hasDraft: false });
    socket.emit("human_message", { text: t });
    outboxRef.current.push(t); // unconfirmed until the server echoes it back

    // Optimistic render: show the participant's message immediately. On Plesk
    // (polling-only transport) the server echo can lag behind by several
    // seconds and arrive batched with bot messages; without this the chat
    // looks frozen between hitting send and seeing your own message. The
    // server's echo handler matches via _optimistic + sender + text and
    // confirms with the authoritative ts.
    setMessages((prev) => [
      ...prev,
      {
        sender: participantName || "",
        message: t,
        direction: "outgoing",
        ts: Date.now(),
        _optimistic: true,
      },
    ]);

    setInput("");
    inputRef.current = "";

    // Keep the cursor in the text box after sending (chatscope's MessageInput
    // blurs the contenteditable on send; refocus it so the user can keep typing
    // without tapping the field again — important on mobile to avoid keyboard flicker).
    requestAnimationFrame(() => {
      const editor = document.querySelector(".cs-message-input__content-editor");
      if (editor && typeof editor.focus === "function") editor.focus();
    });

    // After sending, wait for idle (same as empty input) so we don't advance while user might type again
    const idleEmptyMs = session?.idleEmptyMs ?? 4000;
    idleTimeoutRef.current = setTimeout(() => {
      socket.emit("human_idle");
      idleTimeoutRef.current = null;
    }, idleEmptyMs);
  }

  function goLogin() {
    const sid = session?.sessionId || sessionStorage.getItem("studySessionId") || "";
    if (sid) localStorage.setItem("sessionId", sid);
    const pName = sessionStorage.getItem("participantName") || "";
    if (pName) localStorage.setItem("participantId", pName);
    sessionStorage.setItem("chatCompleted", sid || "1");
    navigate("/login", { replace: true });
  }

  const participantProfilePic = (() => {
    try {
      return sessionStorage.getItem(PARTICIPANT_PROFILE_KEY) || null;
    } catch {
      return null;
    }
  })();

  const myDisplayName = participantName;
  const participants = session ? getParticipants(session, myDisplayName) : [];
  if (participants.length && participants[0].isYou) participants[0].profilePic = participantProfilePic;

  return (
    <div className="chat-page">
      {/* Left sidebar: participant profiles */}
      <aside className="chat-sidebar">
        <div className="chat-sidebar-title">Participants</div>
        {session ? (
          participants.map((p) => (
            <div
              key={p.name}
              className="chat-participant-card"
              style={{ background: p.color }}
            >
              <div className="chat-participant-avatar">
                {p.profilePic ? (
                  <img src={p.profilePic} alt="" />
                ) : (
                  <span className="chat-participant-avatar-fallback">
                    {p.isModerator ? "🎙️" : (p.displayName || "?").charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="chat-participant-info">
                <div className="chat-participant-name-row">
                  <span className={`chat-participant-name${p.isModerator ? " chat-participant-name--moderator" : ""}`}>
                    {p.isYou ? `${p.displayName} (You)` : p.displayName}
                  </span>
                  {p.isModerator && (
                    <span title="Moderator" className="chat-moderator-icon" aria-hidden>🎙️</span>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="chat-connecting">Connecting…</div>
        )}
      </aside>

      <div className="chat-main-wrapper">
      {/* Main chat area: fixed 15cm width; text and input wrap inside, never push */}
      <div className="chat-main">
        <div className="chat-messages-wrapper">
        <MainContainer>
          {/* Custom layout: list | fixed gap (typing) | input — so typing never covers last message */}
          <div className="cs-chat-container chat-layout-with-gap">
            <div className="chat-messages-area">
              <MessageList typingIndicator={null}>
                {messages.map((m, i) => {
                  const isModerator = session?.moderatorName && m.sender === session.moderatorName;
                  const msgText = typeof m.message === "string" ? m.message : String(m.message ?? "").slice(0, 2000);
                  const rendered = renderWithMentions(msgText, session, participantName);
                  const hasMentions = Array.isArray(rendered);
                  return (
                    <div
                      key={i}
                      className={`sender-bubble-wrap${isModerator ? " moderator-bubble" : ""}`}
                      style={{ ["--sender-color"]: getColorForSender(m.sender, session, participantName) }}
                    >
                        <Message
                          model={{
                            message: hasMentions ? " " : msgText,
                            sentTime: fmtTime(m.ts),
                            sender: isModerator ? `${m.sender}${MODERATOR_LABEL}` : m.sender,
                            direction: m.direction,
                            position: "single",
                          }}
                        >
                          <Message.Header sender={isModerator ? `${m.sender}${MODERATOR_LABEL}` : m.sender} sentTime={fmtTime(m.ts)} />
                          {hasMentions && (
                            <Message.CustomContent>{rendered}</Message.CustomContent>
                          )}
                        </Message>
                    </div>
                  );
                })}
              </MessageList>
            </div>
            <div className="chat-typing-gap" aria-live="polite">
              {typingText ? (
                <>
                  <span className="typing-dots" aria-hidden="true">
                    <span /><span /><span />
                  </span>
                  {typingText} typing…
                </>
              ) : (
                "\u00A0"
              )}
            </div>
            <MessageInput
              placeholder={studyComplete ? "Chat ended — click Exit Chat" : "Type..."}
              value={input}
              onChange={handleInputChange}
              // chatscope passes (innerHtml, textContent, innerText). Send the
              // PLAIN TEXT — innerHtml carries pasted rich-text markup.
              onSend={(innerHtml, textContent, innerText) => onSend(innerText || textContent || "")}
              disabled={studyComplete}
            />
          </div>
        </MainContainer>
        </div>

        <div className="chat-footer">
          {(SHOW_EXIT_BUTTON_ALWAYS || studyComplete) && (
            <button onClick={goLogin} className="chat-exit-btn">
              Exit Chat
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}