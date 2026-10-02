import { useEffect } from "react";
import { permitUnload } from "./navGuard.js";

const PROLIFIC_COMPLETE_URL = "https://app.prolific.com/submissions/complete?cc=CQVN22U3";

export default function CompletePage() {
  useEffect(() => {
    // Tell the server the participant reached the final Prolific redirect — this
    // marks the session a "successful instance" for the per-group recruitment
    // cap. keepalive lets the request finish after location.replace below;
    // the server stamps first-wins, so a duplicate beacon is harmless.
    try {
      const sessionId = localStorage.getItem("sessionId") || "";
      const participantId = localStorage.getItem("participantId") || "";
      if (sessionId && participantId) {
        fetch("/api/focus-group/survey-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ sessionId, participantId }),
        }).catch(() => {});
      }
    } catch {
      // ignore — the beacon is best-effort
    }

    // Clear flow flags so the back button doesn't put them in a half-complete state.
    try {
      sessionStorage.removeItem("passedWaiting");
      sessionStorage.removeItem("chatCompleted");
      sessionStorage.removeItem("studySessionId");
    } catch {}

    // If we landed here inside the Qualtrics iframe parent (same-origin), break out
    // to the top window so Prolific gets a real top-level navigation.
    const target = (() => {
      try {
        return window.top && window.top !== window.self ? window.top : window;
      } catch {
        return window;
      }
    })();

    // Legitimate exit — suppress the global reload/close warning so it can't
    // interrupt the handoff back to Prolific.
    permitUnload();
    target.location.replace(PROLIFIC_COMPLETE_URL);
  }, []);

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
        textAlign: "center",
        color: "#222",
      }}
    >
      <h2 style={{ margin: "0 0 12px", color: "#003057" }}>Thank you!</h2>
      <p style={{ color: "#444", maxWidth: 520, lineHeight: 1.6 }}>
        Redirecting you back to Prolific to record your completion…
      </p>
      <p style={{ color: "#666", fontSize: 13, marginTop: 16 }}>
        If you are not redirected,{" "}
        <a href={PROLIFIC_COMPLETE_URL} style={{ color: "#1976d2" }}>
          click here
        </a>
        .
      </p>
    </div>
  );
}
