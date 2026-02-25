import { useEffect, useState } from "react";

export default function LoginChoice() {
  const [start] = useState(Date.now());
  const [status, setStatus] = useState("");

  async function submit(choice) {
    const sessionId = localStorage.getItem("sessionId");
    const hesitationMs = Date.now() - start;

    await fetch("http://localhost:3001/api/login_choice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, choice, hesitationMs }),
    });

    setStatus(`Recorded: ${choice}. (prototype)`);
  }

  useEffect(() => {
    // could add help tooltip clicks etc later
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui" }}>
      <div style={{ maxWidth: 640, margin: "40px auto 0", padding: "0 24px", width: "100%" }}>
        <h2>Compensation Login</h2>
        <p>To receive compensation, please log into the study portal.</p>

        <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
          <button onClick={() => submit("passkey")} style={{ padding: "12px 16px" }}>
            Use Passkey (recommended)
          </button>
          <button onClick={() => submit("password")} style={{ padding: "12px 16px" }}>
            Use Password
          </button>
        </div>

        <div style={{ marginTop: 16, color: "#666" }}>{status}</div>

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