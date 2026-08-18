import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const TOTAL_PARTICIPANTS = 5;
const MIN_WAIT_MS = 5_000;
const MAX_WAIT_MS = 10_000;

export default function WaitingPage() {
  const [count, setCount] = useState(3);
  const [status, setStatus] = useState("joining");
  const navigate = useNavigate();

  // Guard: must come from welcome page, and not already past this step
  useEffect(() => {
    if (!sessionStorage.getItem("participantName") || sessionStorage.getItem("passedWaiting") || sessionStorage.getItem("chatCompleted")) {
      navigate("/welcome", { replace: true });
      return;
    }
  }, [navigate]);

  // Back button and reload/close are handled globally by App.jsx's AccessGuard
  // (back routes to the blocked page, reload warns then blocks), so no per-page trap.

  useEffect(() => {
    let navId = null;
    const totalWait = MIN_WAIT_MS + Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS);
    const half = totalWait / 2;
    const to4 = setTimeout(() => setCount(4), half);
    const toRedirect = setTimeout(() => {
      setStatus("redirecting");
      setCount(TOTAL_PARTICIPANTS);
      navId = setTimeout(() => {
        sessionStorage.setItem("passedWaiting", "1");
        navigate("/chat", { replace: true });
      }, 800);
    }, totalWait);
    return () => {
      clearTimeout(to4);
      clearTimeout(toRedirect);
      if (navId) clearTimeout(navId);
    };
  }, [navigate]);

  return (
    <div
      style={{
        minHeight: "calc(100dvh - 61px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 8, fontSize: "1.5rem" }}>Waiting for other participants to join</h1>
      <p style={{ color: "#666", marginBottom: 8 }}>
        {count}/{TOTAL_PARTICIPANTS} participants…
      </p>
      {status === "redirecting" && (
        <p style={{ color: "#1976d2", marginTop: 16 }}>Redirecting to chat page…</p>
      )}
    </div>
  );
}
