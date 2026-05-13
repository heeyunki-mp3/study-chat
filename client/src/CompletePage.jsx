import { useEffect } from "react";

const PROLIFIC_COMPLETE_URL = "https://app.prolific.com/submissions/complete?cc=CQVN22U3";

export default function CompletePage() {
  useEffect(() => {
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

    target.location.replace(PROLIFIC_COMPLETE_URL);
  }, []);

  return (
    <div
      style={{
        minHeight: "calc(100vh - 61px)",
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
