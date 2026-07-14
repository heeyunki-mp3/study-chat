import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import zxcvbn from "zxcvbn";
import "./FocusGroupFlow.css";

// ─── Shared sub-components ────────────────────────────────────

// Pilot feedback: this page read like the end of the study, so some participants
// might leave without registering + taking the exit survey. Shown on both steps.
function NotFinishedBanner() {
  return (
    <div className="fg-notice-banner" role="alert">
      <strong>You're not finished yet!</strong> Please select a User ID and login
      method to access the final questions and complete the survey.
    </div>
  );
}

function StudyTimeline() {
  return (
    <div className="fg-timeline">
      <span className="fg-timeline-label">Study timeline</span>
      <div className="fg-timeline-item fg-timeline-has-future">
        <div className="fg-timeline-dot" />
        <div className="fg-timeline-content">
          <div className="fg-timeline-row">
            <span className="fg-timeline-title">Today</span>
            <span className="fg-timeline-payout">+$4</span>
          </div>
          <span className="fg-timeline-desc">Paid on submission of the exit survey.</span>
        </div>
      </div>
      <div className="fg-timeline-item fg-timeline-future">
        <div className="fg-timeline-dot fg-timeline-dot-hollow" />
        <div className="fg-timeline-content">
          <div className="fg-timeline-row">
            <span className="fg-timeline-title">In 2 weeks &middot; Follow-up study</span>
            <span className="fg-timeline-payout">+$10</span>
          </div>
          <span className="fg-timeline-desc">
            You&apos;ll sign back in with this same account to complete the follow-up.
          </span>
        </div>
      </div>
    </div>
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

// ─── User ID validation ──────────────────────────────────────

const USER_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const USER_ID_MIN = 3;
const USER_ID_MAX = 32;

function validateUserId(value) {
  if (value.length < USER_ID_MIN) return `User ID must be at least ${USER_ID_MIN} characters.`;
  if (value.length > USER_ID_MAX) return `User ID must be at most ${USER_ID_MAX} characters.`;
  if (!USER_ID_PATTERN.test(value)) return "User ID can only contain letters, numbers, dots, underscores, and hyphens.";
  return "";
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

// ─── Screen 1: User ID ────────────────────────────────────────

function UserIdStep({ onContinue }) {
  const [userId, setUserId] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = userId.trim();
    if (!trimmed) {
      setError("Please create a user ID.");
      return;
    }
    const validationError = validateUserId(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    onContinue(trimmed);
  }

  return (
    <div className="fg-page">
      <NotFinishedBanner />
      <main className="fg-main">
        <div className="fg-container">
          {/* Left: hero */}
          <div className="fg-hero">
            <div>
              <span className="fg-step">Step 1 of 2</span>
            </div>
            <span className="fg-eyebrow">You're almost done</span>
            <h1>One more step to finish the study</h1>
            <p>
              Select a User ID and login method to submit your exit survey and
              receive today's payment. You may also be invited to future paid
              follow-up studies.{" "}
              <strong className="fg-highlight">You will sign in with this account again.</strong>
            </p>
            <StudyTimeline />
          </div>

          {/* Right: form */}
          <div className="fg-form-area">
            <form onSubmit={handleSubmit} noValidate>
              <label className="fg-label" htmlFor="fg-user-id">
                User ID
                <input
                  id="fg-user-id"
                  className="fg-input"
                  type="text"
                  value={userId}
                  onChange={(e) => { setUserId(e.target.value); setError(""); }}
                  placeholder="Create a user ID"
                  autoComplete="username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={USER_ID_MAX}
                  autoFocus={false}
                  aria-describedby="fg-user-id-hint"
                />
              </label>
              <span id="fg-user-id-hint" className="fg-input-hint">
                {USER_ID_MIN}–{USER_ID_MAX} characters: letters, numbers, dots, underscores, or hyphens.
              </span>
              {error && <p className="fg-input-error" role="alert">{error}</p>}

              <button type="submit" className="fg-btn-primary" style={{ marginTop: 20 }}>
                Continue
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Screen 2: Secure ─────────────────────────────────────────

function SecureStep({ userId, onBack }) {
  const navigate = useNavigate();
  const [method, setMethod] = useState(null); // "password" | "passkey"
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ctx = useMemo(getSessionContext, []);
  // Server-assigned order (strict alternation). null while loading.
  const [topMethod, setTopMethod] = useState(null);
  const activeRequestRef = useRef(0); // incremented on each new request to cancel stale ones
  const clicksRef = useRef([]); // ordered log of every method card the user clicked, e.g. ["passkey","password"]
  // Selection/creation timing (all on the client clock):
  // cards shown → LAST method click = dur_auth_selection_ms (back-and-forth
  // switching counts as still selecting); last click → successful registration
  // = dur_auth_creation_ms. E.g. click passkey, change mind, click password,
  // create → selection ends at the password click; creation starts there.
  const shownAtRef = useRef(null); // when the method cards became visible
  const lastClickAtRef = useRef(null); // when the most recent method card was clicked

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/focus-group/assign-auth-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: ctx.sessionId, participantId: ctx.participantId }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data?.authMethodTop === "password" || data?.authMethodTop === "passkey") {
          setTopMethod(data.authMethodTop);
        } else {
          // Server didn't return a valid value — fall back to password-first so the
          // page is still usable.
          setTopMethod("password");
        }
      } catch {
        if (!cancelled) setTopMethod("password");
      }
    })();
    return () => { cancelled = true; };
  }, [ctx.sessionId, ctx.participantId]);

  // The method cards render once topMethod resolves — anchor the selection timer there.
  useEffect(() => {
    if (topMethod !== null && shownAtRef.current === null) {
      shownAtRef.current = Date.now();
    }
  }, [topMethod]);

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
        // Server still keys this on `email` — pass the user ID through that field.
        body: JSON.stringify({
          email: userId,
          password,
          sessionId: ctx.sessionId,
          participantId: ctx.participantId,
          // Final durations, anchored on the LAST method click before this success:
          // selection = cards shown → last click; creation = last click → now.
          authSelectionMs:
            shownAtRef.current !== null && lastClickAtRef.current !== null
              ? lastClickAtRef.current - shownAtRef.current
              : undefined,
          authCreationMs: lastClickAtRef.current !== null ? Date.now() - lastClickAtRef.current : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      sessionStorage.setItem("sessionToken", data.sessionToken);
      // Record the auth method the participant completed registration with, for
      // Qualtrics: pw = password, pk = passkey.
      sessionStorage.setItem("pw_vs_pk", "pw");
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
        body: JSON.stringify({ email: userId, sessionId: ctx.sessionId, participantId: ctx.participantId }),
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
        body: JSON.stringify({
          email: userId,
          attestation,
          sessionId: ctx.sessionId,
          participantId: ctx.participantId,
          // Final durations, anchored on the LAST method click before this success:
          // selection = cards shown → last click; creation = last click → now.
          authSelectionMs:
            shownAtRef.current !== null && lastClickAtRef.current !== null
              ? lastClickAtRef.current - shownAtRef.current
              : undefined,
          authCreationMs: lastClickAtRef.current !== null ? Date.now() - lastClickAtRef.current : undefined,
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok) throw new Error(verData.error || "Passkey verification failed");
      if (activeRequestRef.current !== requestId) return;

      sessionStorage.setItem("sessionToken", verData.sessionToken);
      // Record the auth method the participant completed registration with, for
      // Qualtrics: pw = password, pk = passkey.
      sessionStorage.setItem("pw_vs_pk", "pk");
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

  function logClicks() {
    // Fire-and-forget: persist the running click log immediately so it survives
    // even if the participant abandons the page or cancels the passkey prompt.
    // keepalive lets the request finish if the page starts navigating away.
    try {
      fetch("/api/focus-group/log-auth-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          sessionId: ctx.sessionId,
          participantId: ctx.participantId,
          authMethodClicks: clicksRef.current,
          // Cards shown → this (latest) click. Each click overwrites on the server,
          // so the stored value tracks the LAST click; registration finalizes it.
          msFromShownToLastClick:
            shownAtRef.current !== null && lastClickAtRef.current !== null
              ? lastClickAtRef.current - shownAtRef.current
              : undefined,
        }),
      }).catch(() => {});
    } catch {
      // ignore — logging is best-effort
    }
  }

  function selectMethod(m) {
    // Cancel any in-flight request
    activeRequestRef.current += 1;
    lastClickAtRef.current = Date.now(); // every click re-anchors the selection→creation split
    clicksRef.current.push(m); // record every click, including back-and-forth switches
    logClicks(); // persist on every click, not just on successful registration
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
      <NotFinishedBanner />
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
              You'll use this account again in <strong>2 weeks</strong> for the
              paid follow-up study, so pick something you'll have access to.
              Your exit survey and any future study data are tied to it.
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
              label={method ? "Back to method selection" : "Back to user ID"}
            />
            <span className="fg-methods-label">Choose a sign-in method</span>

            <div className="fg-methods">
              {topMethod === null && (
                <p style={{ fontSize: 14, color: "var(--ink-3)", margin: "8px 0" }}>Loading sign-in options…</p>
              )}
              {topMethod !== null && (topMethod === "password" ? ["password", "passkey"] : ["passkey", "password"]).map((m) => (
                m === "password" ? (
                  <button
                    key="password"
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
                ) : (
                  <button
                    key="passkey"
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
                )
              ))}
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
    </div>
  );
}

// ─── Main export: two-step flow ───────────────────────────────

export default function LoginChoice() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [userId, setUserId] = useState("");

  // Warn the participant before they reload or close the tab anywhere on the login/
  // registration page (both the user-ID step and the password/passkey step).
  // Abandoning here loses their place in the study and forfeits payment. The native
  // browser dialog can't show custom text (browsers force a generic "Reload site? /
  // Leave site?" message), but it forces a confirmation. The forward navigation to
  // /survey unmounts this page (and is client-side), so it won't trigger the warning.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to show the prompt
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Guard: must have completed the chat — and not by being kicked (kicked users
  // also have chatCompleted set, but must not reach registration/survey; "/"
  // shows them the kicked end screen via the studyEnded flag).
  const chatCompleted = sessionStorage.getItem("chatCompleted");
  const wasKicked = sessionStorage.getItem("studyEnded") === "kicked";
  if (!chatCompleted || wasKicked) {
    navigate("/", { replace: true });
    return null;
  }

  function handleUserIdContinue(validUserId) {
    setUserId(validUserId);
    sessionStorage.setItem("registrationUserId", validUserId);
    setStep(2);
  }

  if (step === 1) {
    return <UserIdStep onContinue={handleUserIdContinue} />;
  }

  return <SecureStep userId={userId} onBack={() => setStep(1)} />;
}
