import { useState } from "react";

export default function LoginChoice() {
  const [start] = useState(Date.now());
  const [status, setStatus] = useState("");

  async function submit(choice) {
    const sessionId = localStorage.getItem("sessionId");
    const participantId = localStorage.getItem("participantId");
    const hesitationMs = Date.now() - start;

    try {
      await fetch("/api/auth_choice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, participantId, choice, hesitationMs }),
      });
      setStatus(`Recorded: ${choice}`);
    } catch (e) {
      setStatus("Failed to save choice. Please try again.");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui" }}>
      <div style={{ maxWidth: 640, margin: "40px auto 0", padding: "0 24px", width: "100%" }}>
        <h2>Compensation Login</h2>
        <p>To receive compensation, please log into the study portal.</p>

        <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
          <button
            onClick={() => submit("passkey")}
            disabled={!!status}
            style={{
              padding: "12px 24px",
              fontSize: 16,
              borderRadius: 8,
              border: "1px solid #1976d2",
              background: "#1976d2",
              color: "#fff",
              cursor: status ? "default" : "pointer",
            }}
          >
            Use Passkey (recommended)
          </button>
          <button
            onClick={() => submit("password")}
            disabled={!!status}
            style={{
              padding: "12px 24px",
              fontSize: 16,
              borderRadius: 8,
              border: "1px solid #ccc",
              background: "#fff",
              color: "#333",
              cursor: status ? "default" : "pointer",
            }}
          >
            Use Password
          </button>
        </div>

        {status && <div style={{ marginTop: 16, color: "#388e3c", fontWeight: 500 }}>{status}</div>}

        <hr style={{ margin: "32px 0 16px", borderColor: "#e0e0e0" }} />
        <p style={{ color: "#666", fontSize: 14 }}>Please also complete the study survey below:</p>
      </div>

      <iframe
        src="https://qualtricsxml5jbfgkjs.qualtrics.com/jfe/form/SV_1LBmGog10Hsu6r4"
        style={{ flex: 1, border: "none", width: "100%", marginTop: 8 }}
        title="Study Survey"
        allow="fullscreen"
      />
    </div>
  );
}
