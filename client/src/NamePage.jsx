import { useState } from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "participantName";

export default function NamePage() {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = (name || "").trim();
    if (!trimmed) {
      setError("Please enter your name.");
      return;
    }
    setError("");
    try {
      sessionStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      setError("Could not save name.");
      return;
    }
    navigate("/waiting", { replace: true });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 8, fontSize: "1.5rem" }}>Welcome</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>Please enter your name to join the discussion.</p>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 320 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 16,
            border: "1px solid #ccc",
            borderRadius: 8,
            marginBottom: 8,
            boxSizing: "border-box",
          }}
        />
        {error && (
          <p style={{ color: "#c00", fontSize: 14, marginBottom: 8 }}>{error}</p>
        )}
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 16,
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}

export { STORAGE_KEY };
