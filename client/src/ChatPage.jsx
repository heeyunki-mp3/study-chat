import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
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

function getColorForSender(sender, session, myName) {
  if (!sender) return PARTICIPANT_PALETTE[0];
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
      profilePic: null,
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
      profilePic: `${SERVER_BASE}/profile_pictures/profile_${(i % 9) + 1}.jpg`,
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

  // Debounce: stop-typing after 800ms; then idle = session.idleEmptyMs (empty) or session.idleTypingMs (has text)
  const typingTimeoutRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const inputRef = useRef("");

  useEffect(() => {
    if (!participantName) {
      navigate("/", { replace: true });
      return;
    }

    socket.on("connect", () => {
      console.log("connected", socket.id);
      socket.emit("participant_name", { name: participantName });
    });
    socket.on("connect_error", (err) => console.log("connect_error", err));

    socket.on("session", (s) => setSession(s));

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

    socket.on("message", (m) => {
      const text = typeof m?.text === "string" ? m.text : String(m?.text ?? "").slice(0, 2000);
      const sender = m?.name ?? "";
      setMessages((prev) => [
        ...prev,
        {
          sender,
          message: text,
          direction: sender === participantName ? "outgoing" : "incoming",
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
      navigate("/login", { replace: true });
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
    if (session?.sessionId) localStorage.setItem("sessionId", session.sessionId);
    window.location.href = "/login";
  }

  const participantProfilePic = (() => {
    try {
      return sessionStorage.getItem(PARTICIPANT_PROFILE_KEY) || null;
    } catch {
      return null;
    }
  })();

  const participants = session ? getParticipants(session, participantName) : [];
  if (participants.length && participants[0].isYou) participants[0].profilePic = participantProfilePic;

  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden" }}>
      {/* Left sidebar: participant profiles */}
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid #e0e0e0",
          padding: "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "#fafafa",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Participants</div>
        {session ? (
          participants.map((p) => (
            <div
              key={p.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 10,
                background: p.color,
                border: "1px solid rgba(0,0,0,0.08)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  overflow: "hidden",
                  flexShrink: 0,
                  background: "rgba(255,255,255,0.6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {p.profilePic ? (
                  <img
                    src={p.profilePic}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <span style={{ fontSize: 18, color: "#444" }}>
                    {p.isModerator ? "🎙️" : (p.displayName || "?").charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{
                      fontWeight: p.isModerator ? 600 : 500,
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: p.isModerator ? "#1565c0" : "#1a1a1a",
                    }}>
                    {p.isYou ? `${p.displayName} (You)` : p.displayName}
                  </span>
                  {p.isModerator && (
                    <span title="Moderator" style={{ flexShrink: 0 }} aria-hidden>🎙️</span>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div style={{ color: "#999", fontSize: 14 }}>Connecting…</div>
        )}
      </aside>

      {/* Main chat area: fixed 15cm width; text and input wrap inside, never push */}
      <div style={{ width: "15cm", minWidth: "15cm", maxWidth: "15cm", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
        <div style={{ height: "75vh", flex: "1 1 0", minHeight: 0, minWidth: 0, width: "100%", overflow: "hidden" }}>
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
                      style={{ ["--sender-color"]: getColorForSender(m.sender, session, participantName) }}
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

        <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ color: "#666" }}>Chat a bit, then proceed to login.</div>
          <button onClick={goLogin} style={{ padding: "10px 14px" }}>
            Proceed to Login
          </button>
        </div>
      </div>
    </div>
  );
}