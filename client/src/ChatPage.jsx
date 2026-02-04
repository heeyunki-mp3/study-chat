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

// Slightly different bubble colors per person (light tints)
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

function getColorForSender(sender, session, myName) {
  if (!sender) return SENDER_COLORS[0];
  const participants = [myName || "You", ...(session?.bots || [])];
  const i = participants.indexOf(sender);
  if (i >= 0) return SENDER_COLORS[i % SENDER_COLORS.length];
  let h = 0;
  for (let j = 0; j < String(sender).length; j++) h = (h << 5) - h + String(sender).charCodeAt(j);
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length];
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

  // ✅ NEW: debounce timer
  const typingTimeoutRef = useRef(null);

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

    socket.connect();

    return () => {
      // ✅ ensure server doesn't think you're typing forever
      try {
        socket.emit("human_typing", { isTyping: false });
      } catch {
        /* ignore on cleanup */
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      socket.disconnect();
    };
  }, [socket, participantName, navigate]);

  const typingText = Object.entries(typing)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  // ✅ NEW: fires on every keystroke
  function handleInputChange(val) {
    setInput(val);

    // tell server: human is typing
    socket.emit("human_typing", { isTyping: true });

    // debounce stop-typing
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit("human_typing", { isTyping: false });
      typingTimeoutRef.current = null;
    }, 800);
  }

  function onSend(text) {
    const t = (text || "").trim();
    if (!t) return;

    // ✅ stop typing immediately on send
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    socket.emit("human_typing", { isTyping: false });

    socket.emit("human_message", { text: t });

    // clear input locally (MessageInput also clears, but we control value now)
    setInput("");
  }

  function goLogin() {
    socket.emit("end");
    if (session?.sessionId) localStorage.setItem("sessionId", session.sessionId);
    window.location.href = "/login";
  }

  return (
    <div style={{ height: "100vh", padding: 16 }}>
      <div style={{ marginBottom: 8, color: "#666" }}>
        {session ? `Group chat: ${(session.bots || []).join(", ")}` : "Connecting..."}
      </div>

      <div style={{ height: "75vh" }}>
        <MainContainer>
          {/* Custom layout: list | fixed gap (typing) | input — so typing never covers last message */}
          <div className="cs-chat-container chat-layout-with-gap">
            <div className="chat-messages-area">
              <MessageList typingIndicator={null}>
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className="sender-bubble-wrap"
                    style={{ ["--sender-color"]: getColorForSender(m.sender, session, participantName) }}
                  >
                    <Message
                      model={{
                        message: typeof m.message === "string" ? m.message : String(m.message ?? "").slice(0, 2000),
                        sentTime: fmtTime(m.ts),
                        sender: m.sender,
                        direction: m.direction,
                        position: "single",
                      }}
                    >
                      <Message.Header sender={m.sender} sentTime={fmtTime(m.ts)} />
                    </Message>
                  </div>
                ))}
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

      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
        <div style={{ color: "#666" }}>Chat a bit, then proceed to login.</div>
        <button onClick={goLogin} style={{ padding: "10px 14px" }}>
          Proceed to Login
        </button>
      </div>
    </div>
  );
}