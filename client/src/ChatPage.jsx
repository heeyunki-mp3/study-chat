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
const SERVER_BASE = "http://127.0.0.1:3001";

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

function isSelf(sender, myName, introducedName) {
  const s = String(sender || "").toLowerCase();
  if (myName && s === String(myName).toLowerCase()) return true;
  if (introducedName && s === String(introducedName).toLowerCase()) return true;
  return false;
}

function getColorForSender(sender, session, myName, introducedName = null) {
  if (!sender) return PARTICIPANT_PALETTE[0];
  if (isSelf(sender, myName, introducedName)) return PARTICIPANT_PALETTE[0];
  const ordered = getOrderedParticipantNames(session, myName);
  const i = ordered.indexOf(sender);
  if (i >= 0) return PARTICIPANT_PALETTE[i % PARTICIPANT_PALETTE.length];
  let h = 0;
  for (let j = 0; j < String(sender).length; j++) h = (h << 5) - h + String(sender).charCodeAt(j);
  return PARTICIPANT_PALETTE[Math.abs(h) % PARTICIPANT_PALETTE.length];
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
      profilePic: `${SERVER_BASE}/profile_pictures/${bot}.png`,
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
      io("http://127.0.0.1:3001", {
        autoConnect: false,
        transports: ["polling"],
        withCredentials: true,
      }),
    []
  );

  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState({});
  const [session, setSession] = useState(null);
  const [input, setInput] = useState("");
  const [introducedName, setIntroducedName] = useState(null);
  const introducedNameRef = useRef(null);

  // Debounce: stop-typing after 800ms; then idle = session.idleEmptyMs (empty) or session.idleTypingMs (has text)
  const typingTimeoutRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const inputRef = useRef("");

  // If user presses back, send them to "/" (new session) instead of previous page
  useEffect(() => {
    window.history.replaceState(null, "", "/chat");
    window.history.pushState(null, "", "/chat");
    const onBack = () => {
      navigate("/", { replace: true });
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [navigate]);

  useEffect(() => {
    if (!participantName || !sessionStorage.getItem("passedWaiting") || sessionStorage.getItem("chatCompleted")) {
      navigate("/", { replace: true });
      return;
    }

    socket.on("connect", () => {
      console.log("connected", socket.id);
      socket.emit("participant_name", { name: participantName });
    });
    socket.on("connect_error", (err) => console.log("connect_error", err));

    socket.on("session", (s) => {
      setSession(s);
      if (s?.sessionId) sessionStorage.setItem("studySessionId", s.sessionId);
    });

    socket.on("seed", (seedMsgs) => {
      setMessages((prev) => [
        ...prev,
        ...(Array.isArray(seedMsgs) ? seedMsgs : []).map((m) => ({
          sender: m?.name ?? "",
          message: typeof m?.text === "string" ? m.text : String(m?.text ?? "").slice(0, 2000),
          direction: "incoming",
          ts: m?.ts,
        })),
      ]);
    });

    socket.on("introduced_name", ({ name } = {}) => {
      if (name) {
        introducedNameRef.current = name;
        setIntroducedName(name);
        // Retroactively rename any already-stored messages that belong to the user
        // so the full chat history shows the introduced name consistently.
        setMessages((prev) =>
          prev.map((m) =>
            isSelf(m.sender, participantName, name) ? { ...m, sender: name } : m
          )
        );
      }
    });

    socket.on("message", (m) => {
      const text = typeof m?.text === "string" ? m.text : String(m?.text ?? "").slice(0, 2000);
      const sender = m?.name ?? "";
      const isOutgoing = isSelf(sender, participantName, introducedNameRef.current);
      setMessages((prev) => [
        ...prev,
        {
          sender,
          message: text,
          direction: isOutgoing ? "outgoing" : "incoming",
          ts: m?.ts,
        },
      ]);
    });

    socket.on("typing", ({ who, isTyping }) => {
      setTyping((prev) => ({ ...prev, [who]: isTyping }));
    });

    socket.on("kicked", ({ message } = {}) => {
      socket.disconnect();
      alert(message || "You have been removed from the session.");
      sessionStorage.setItem("chatCompleted", sessionStorage.getItem("studySessionId") || "1");
      navigate("/survey", { replace: true });
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

  // Fires on every keystroke
  function handleInputChange(val) {
    setInput(val);
    inputRef.current = val ?? "";
    const hasDraft = String(val ?? "").trim().length > 0;

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

  function onSend(text) {
    const t = (text || "").trim();
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

    setInput("");
    inputRef.current = "";

    // After sending, wait for idle (same as empty input) so we don't advance while user might type again
    const idleEmptyMs = session?.idleEmptyMs ?? 4000;
    idleTimeoutRef.current = setTimeout(() => {
      socket.emit("human_idle");
      idleTimeoutRef.current = null;
    }, idleEmptyMs);
  }

  function goLogin() {
    socket.emit("end");
    const sid = session?.sessionId || sessionStorage.getItem("studySessionId") || "";
    if (sid) localStorage.setItem("sessionId", sid);
    sessionStorage.setItem("chatCompleted", sid || "1");
    navigate("/survey", { replace: true });
  }

  const participantProfilePic = (() => {
    try {
      return sessionStorage.getItem(PARTICIPANT_PROFILE_KEY) || null;
    } catch {
      return null;
    }
  })();

  // Use the introduced name for the sidebar if the user gave one during intro.
  const myDisplayName = introducedName || participantName;
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
                  return (
                    <div
                      key={i}
                      className={`sender-bubble-wrap${isModerator ? " moderator-bubble" : ""}`}
                      style={{ ["--sender-color"]: getColorForSender(m.sender, session, participantName, introducedName) }}
                    >
                        <Message
                          model={{
                            message: typeof m.message === "string" ? m.message : String(m.message ?? "").slice(0, 2000),
                            sentTime: fmtTime(m.ts),
                            sender: isModerator ? `${m.sender}${MODERATOR_LABEL}` : m.sender,
                            direction: m.direction,
                            position: "single",
                          }}
                        >
                          <Message.Header sender={isModerator ? `${m.sender}${MODERATOR_LABEL}` : m.sender} sentTime={fmtTime(m.ts)} />
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
              placeholder="Type..."
              value={input}
              onChange={handleInputChange}
              onSend={onSend}
            />
          </div>
        </MainContainer>
        </div>

        <div className="chat-footer">
          <button onClick={goLogin} className="chat-exit-btn">
            Exit to Survey
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}