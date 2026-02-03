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
    <div style={{ maxWidth: 640, margin: "60px auto", fontFamily: "system-ui" }}>
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
    </div>
  );
}