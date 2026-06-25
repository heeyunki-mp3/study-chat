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

  // If user presses back, send them to "/" (new session) instead of previous page
  useEffect(() => {
    window.history.replaceState(null, "", "/waiting");
    window.history.pushState(null, "", "/waiting");
    const onBack = () => {
      navigate("/welcome", { replace: true });
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [navigate]);

  // Warn the participant before they reload or close the tab in the waiting room.
  // Reloading here drops their spot and forfeits payment. The native browser dialog
  // can't show custom text (browsers force a generic "Reload site? / Leave site?"
  // message), but it forces a confirmation. The auto-advance to /chat is a
  // client-side navigation that unmounts this page, so it won't trigger the warning.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to show the prompt
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

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
        minHeight: "100dvh",
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
