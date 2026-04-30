import { useState, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import zxcvbn from "zxcvbn";
import "./FocusGroupFlow.css";

// ─── Shared sub-components ────────────────────────────────────

function StudyTimeline() {
  return (
    <div className="fg-timeline">
      <span className="fg-timeline-label">Study timeline</span>
      <div className="fg-timeline-item fg-timeline-has-future">
        <div className="fg-timeline-dot" />
        <div className="fg-timeline-content">
          <span className="fg-timeline-title">Today &middot; $3 on submission</span>
        </div>
      </div>
      <div className="fg-timeline-item fg-timeline-future">
        <div className="fg-timeline-dot fg-timeline-dot-hollow" />
        <div className="fg-timeline-content">
          <span className="fg-timeline-title">Future follow-ups &middot; Also compensated</span>
        </div>
      </div>
    </div>
  );
}

function TrustFooter() {
  return (
    <footer className="fg-footer">
      <span>Paid within 24h</span>
      <span className="fg-footer-dot" aria-hidden="true" />
      <span>Withdraw anytime</span>
    </footer>
  );
}

// ─── Icons (inline SVG) ───────────────────────────────────────

function PasswordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function PasskeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M12 10v12" />
      <path d="M18 16l-6-2-6 2" />
    </svg>
  );
}

function BackButton({ onClick, label }) {
  return (
    <button
      type="button"
      className="fg-back-btn"
      onClick={onClick}
      aria-label={label || "Go back"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

// ─── Email validation (RFC 5322 simplified) ───────────────────

function isValidEmail(email) {
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(email);
}

// zxcvbn score 0–4 → label + color
const STRENGTH_META = [
  { label: "Very weak", color: "#dc2626" },
  { label: "Weak", color: "#ea580c" },
  { label: "Fair", color: "#ca8a04" },
  { label: "Strong", color: "#16a34a" },
  { label: "Very strong", color: "#059669" },
];

function PasswordStrengthBar({ password }) {
  const score = password.length > 0 ? zxcvbn(password).score : -1;
  const meta = score >= 0 ? STRENGTH_META[score] : null;
  const segments = 4; // 4 bar segments

  return (
    <div className="fg-strength" aria-label={meta ? `Password strength: ${meta.label}` : "Password strength"}>
      <div className="fg-strength-bar">
        {Array.from({ length: segments }, (_, i) => (
          <div
            key={i}
            className="fg-strength-segment"
            style={{
              background: score >= 0 && i <= score ? meta.color : "var(--border)",
            }}
          />
        ))}
      </div>
      {meta && (
        <span className="fg-strength-label" style={{ color: meta.color }}>
          {meta.label}
        </span>
      )}
    </div>
  );
}

// ─── Session context helper ──────────────────────────────────

function getSessionContext() {
  return {
    sessionId: localStorage.getItem("sessionId") || "",
    participantId: localStorage.getItem("participantId") || "",
  };
}

// ─── Screen 1: Email ──────────────────────────────────────────

function EmailStep({ onContinue }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter your email address.");
      return;
    }
    if (!isValidEmail(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }
    setError("");
    onContinue(trimmed);
  }

  return (
    <div className="fg-page">
      <main className="fg-main">
        <div className="fg-container">
          {/* Left: hero */}
          <div className="fg-hero">
            <div>
              <span className="fg-step">Step 1 of 2</span>
            </div>
            <span className="fg-eyebrow">You're almost done</span>
            <h1>Register to continue</h1>
            <p>
              Create an account to submit your exit survey and receive today's
              payment. You may also be invited to future paid follow-up studies.
            </p>
            <StudyTimeline />
          </div>

          {/* Right: form */}
          <div className="fg-form-area">
            <form onSubmit={handleSubmit} noValidate>
              <label className="fg-label" htmlFor="fg-email">
                Email
                <input
                  id="fg-email"
                  className="fg-input"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(""); }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus={false}
                  aria-describedby="fg-email-hint"
                />
              </label>
              <span id="fg-email-hint" className="fg-input-hint">
                Used for your payment and any future study invitations.
              </span>
              {error && <p className="fg-input-error" role="alert">{error}</p>}

              <button type="submit" className="fg-btn-primary" style={{ marginTop: 20 }}>
                Continue
              </button>
            </form>

            <a href="/login" className="fg-link" style={{ marginTop: 4 }}>
              Returning participant? Log in
            </a>
          </div>
        </div>
      </main>
      <TrustFooter />
    </div>
  );
}

// ─── Screen 2: Secure ─────────────────────────────────────────

function SecureStep({ email, onBack }) {
  const navigate = useNavigate();
  const [method, setMethod] = useState(null); // "password" | "passkey"
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hesitationStart] = useState(Date.now());
  const ctx = useMemo(getSessionContext, []);
  const activeRequestRef = useRef(0); // incremented on each new request to cancel stale ones

  // Record auth choice in participant_responses
  const recordChoice = useCallback(async (choice) => {
    const hesitationMs = Date.now() - hesitationStart;
    try {
      await fetch("/api/auth_choice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: ctx.sessionId, participantId: ctx.participantId, choice, hesitationMs }),
      });
    } catch {
      // non-critical — don't block registration
    }
  }, [hesitationStart, ctx]);

  async function handlePasswordSubmit(e) {
    e.preventDefault();
    if (!password) {
      setError("Please enter a password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/focus-group/register-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, sessionId: ctx.sessionId, participantId: ctx.participantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      await recordChoice("password");
      sessionStorage.setItem("sessionToken", data.sessionToken);
      navigate("/survey", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskey(requestId) {
    setLoading(true);
    setError("");
    try {
      // 1. Get registration options from server
      const optRes = await fetch("/api/focus-group/webauthn-register-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, sessionId: ctx.sessionId, participantId: ctx.participantId }),
      });
      const optData = await optRes.json();
      if (!optRes.ok) throw new Error(optData.error || "Failed to start passkey registration");
      if (activeRequestRef.current !== requestId) return;

      // 2. Browser ceremony
      const attestation = await startRegistration({ optionsJSON: optData.options });
      if (activeRequestRef.current !== requestId) return;

      // 3. Verify with server
      const verRes = await fetch("/api/focus-group/webauthn-register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, attestation, sessionId: ctx.sessionId, participantId: ctx.participantId }),
      });
      const verData = await verRes.json();
      if (!verRes.ok) throw new Error(verData.error || "Passkey verification failed");
      if (activeRequestRef.current !== requestId) return;

      await recordChoice("passkey");
      sessionStorage.setItem("sessionToken", verData.sessionToken);
      navigate("/survey", { replace: true });
    } catch (err) {
      if (activeRequestRef.current !== requestId) return;
      if (err.name === "NotAllowedError") {
        setError("Passkey registration was cancelled. Please try again.");
      } else {
        setError(err.message);
      }
    } finally {
      if (activeRequestRef.current === requestId) setLoading(false);
    }
  }

  function selectMethod(m) {
    // Cancel any in-flight request
    activeRequestRef.current += 1;
    setLoading(false);
    setMethod(m);
    setPassword("");
    setError("");
    if (m === "passkey") {
      handlePasskey(activeRequestRef.current);
    }
  }

  return (
    <div className="fg-page">
      <main className="fg-main">
        <div className="fg-container">
          {/* Left: hero */}
          <div className="fg-hero">
            <div>
              <span className="fg-step">Step 2 of 2</span>
            </div>
            <span className="fg-eyebrow">You're almost done</span>
            <h1>Secure your account</h1>
            <p>
              Your exit survey contains sensitive information. Secure your
              account with a strong password or passkey — it's the only thing
              protecting your responses and any future study data tied to your
              account.
            </p>
            <StudyTimeline />
          </div>

          {/* Right: method picker */}
          <div className="fg-form-area">
            <BackButton
              onClick={() => {
                activeRequestRef.current += 1;
                setLoading(false);
                if (method) { setMethod(null); setPassword(""); setError(""); }
                else { onBack(); }
              }}
              label={method ? "Back to method selection" : "Back to email"}
            />
            <span className="fg-methods-label">Choose a sign-in method</span>

            <div className="fg-methods">
              {/* Password card */}
              <button
                type="button"
                className={`fg-method-card${method === "password" ? " fg-method-active" : ""}`}
                onClick={() => selectMethod("password")}
                disabled={loading}
                aria-pressed={method === "password"}
              >
                <div className="fg-method-icon"><PasswordIcon /></div>
                <div className="fg-method-text">
                  <h3>Password</h3>
                  <p>Set a strong password you'll remember</p>
                </div>
              </button>

              {/* Passkey card */}
              <button
                type="button"
                className={`fg-method-card${method === "passkey" ? " fg-method-active" : ""}`}
                onClick={() => selectMethod("passkey")}
                disabled={loading}
                aria-pressed={method === "passkey"}
              >
                <div className="fg-method-icon"><PasskeyIcon /></div>
                <div className="fg-method-text">
                  <h3>Passkey</h3>
                  <p>Use Touch ID, Face ID, or a security key</p>
                </div>
              </button>
            </div>

            {/* Password inline form */}
            {method === "password" && (
              <form onSubmit={handlePasswordSubmit} className="fg-password-form">
                <label className="fg-label" htmlFor="fg-password">
                  Password
                  <input
                    id="fg-password"
                    className="fg-input"
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(""); }}
                    placeholder="Create a strong password"
                    autoComplete="new-password"
                    autoFocus
                    aria-describedby="fg-pw-strength"
                  />
                </label>

                <PasswordStrengthBar password={password} />

                <button
                  type="submit"
                  className="fg-btn-primary"
                  disabled={!password || loading}
                >
                  {loading ? "Creating account\u2026" : "Create account"}
                </button>
              </form>
            )}

            {/* Passkey loading state */}
            {method === "passkey" && loading && (
              <p style={{ fontSize: 14, color: "var(--ink-3)" }}>
                Follow the prompts in your browser to register your passkey&hellip;
              </p>
            )}

            {error && <div className="fg-error-banner" role="alert">{error}</div>}
          </div>
        </div>
      </main>
      <TrustFooter />
    </div>
  );
}

// ─── Main export: two-step flow ───────────────────────────────

export default function LoginChoice() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");

  // Guard: must have completed chat
  const chatCompleted = sessionStorage.getItem("chatCompleted");
  if (!chatCompleted) {
    navigate("/", { replace: true });
    return null;
  }

  function handleEmailContinue(validEmail) {
    setEmail(validEmail);
    sessionStorage.setItem("registrationEmail", validEmail);
    setStep(2);
  }

  if (step === 1) {
    return <EmailStep onContinue={handleEmailContinue} />;
  }

  return <SecureStep email={email} onBack={() => setStep(1)} />;
}
