import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { permitUnload } from "./navGuard.js";

const CONSENT_KEY = "participantConsent";

// Prolific completion codes for the two early-exit paths. Completed studies use a
// third code (see SurveyPage / CompletePage).
const PROLIFIC_KICKED_URL = "https://app.prolific.com/submissions/complete?cc=CN7JBFL7";
const PROLIFIC_DECLINED_URL = "https://app.prolific.com/submissions/complete?cc=C8ZQ9LBY";
const REDIRECT_COUNTDOWN_S = 5;

export default function ConsentPage() {
  const [choice, setChoice] = useState(null); // "agree" | "decline" | null
  const [error, setError] = useState("");
  // Kicked participants (idle / unsubstantial / inappropriate) are redirected here
  // with ?kicked=1; they see the same end screen as declined consent but are sent
  // to a different Prolific completion code. The sessionStorage flag makes the
  // lockout stick for the whole tab: even a bare "/" (back button, retyped URL)
  // shows the end screen instead of the consent form, so the study can't be
  // restarted after a kick.
  const [kicked] = useState(() => {
    try {
      return (
        new URLSearchParams(window.location.search).get("kicked") === "1" ||
        sessionStorage.getItem("studyEnded") === "kicked"
      );
    } catch {
      return new URLSearchParams(window.location.search).get("kicked") === "1";
    }
  });
  const [declined, setDeclined] = useState(
    () => new URLSearchParams(window.location.search).get("declined") === "1"
  );
  const [countdown, setCountdown] = useState(REDIRECT_COUNTDOWN_S);
  const navigate = useNavigate();

  const exitUrl = kicked ? PROLIFIC_KICKED_URL : PROLIFIC_DECLINED_URL;
  const showEndScreen = kicked || declined;

  // End screen: count down 5-4-3-2-1, then send them back to Prolific so the
  // submission is recorded with the right completion code instead of timing out.
  useEffect(() => {
    if (!showEndScreen) return;
    const interval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [showEndScreen]);

  useEffect(() => {
    if (showEndScreen && countdown === 0) {
      // Legitimate exit to Prolific — suppress the global reload/close warning so it
      // can't interrupt the redirect (the declined end screen is state-driven and may
      // still count as a protected page).
      permitUnload();
      window.location.replace(exitUrl);
    }
  }, [showEndScreen, countdown, exitUrl]);

  // Capture Prolific URL params on entry so they survive even if the participant
  // declines (we still want to know they hit the funnel).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prolificPid = params.get("PROLIFIC_PID");
    const studyId = params.get("STUDY_ID");
    const prolificSessionId = params.get("SESSION_ID");
    if (prolificPid) sessionStorage.setItem("PROLIFIC_PID", prolificPid);
    if (studyId) sessionStorage.setItem("STUDY_ID", studyId);
    if (prolificSessionId) sessionStorage.setItem("PROLIFIC_SESSION_ID", prolificSessionId);
    // Funnel timing: when the participant first opened the app (per tab). Sent to
    // the server with participant_name and stored as ts_opened. First visit wins —
    // a reload doesn't reset it.
    if (!sessionStorage.getItem("openedAtMs")) {
      sessionStorage.setItem("openedAtMs", String(Date.now()));
    }
  }, []);

  function handleNext() {
    if (!choice) {
      setError("Please select an option to continue.");
      return;
    }
    setError("");
    if (choice === "agree") {
      sessionStorage.setItem(CONSENT_KEY, "agreed");
      navigate("/welcome", { replace: true });
    } else {
      sessionStorage.removeItem(CONSENT_KEY);
      // Record the decline in the DB (exit_status='no_consent') — decliners never
      // reach the chat, so no row would exist otherwise. Best-effort; keepalive
      // lets it finish even though the Prolific redirect follows shortly.
      try {
        fetch("/api/focus-group/no-consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            prolificPid: sessionStorage.getItem("PROLIFIC_PID") || undefined,
            studyId: sessionStorage.getItem("STUDY_ID") || undefined,
            prolificSessionId: sessionStorage.getItem("PROLIFIC_SESSION_ID") || undefined,
          }),
        }).catch(() => {});
      } catch {
        // ignore — recording the decline must never block the decline screen
      }
      setDeclined(true);
    }
  }

  if (showEndScreen) {
    return (
      <div
        style={{
          minHeight: "calc(100dvh - 61px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          boxSizing: "border-box",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <h2 style={{ marginBottom: 12, fontSize: "1.4rem", color: "#003057" }}>
          Thank you for your interest
        </h2>
        <p style={{ color: "#444", maxWidth: 520, lineHeight: 1.6 }}>
          {kicked
            ? "Your session has ended, and you will not proceed to the next step."
            : "Since you did not agree to participate, you will not proceed to the next step."}
        </p>
        <p style={{ color: "#1976d2", marginTop: 16 }}>
          Redirecting you back to Prolific in {countdown}…
        </p>
        <p style={{ color: "#666", fontSize: 13, marginTop: 8 }}>
          If you are not redirected,{" "}
          <a href={exitUrl} style={{ color: "#1976d2" }}>
            click here
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "calc(100dvh - 61px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 24px 40px",
        boxSizing: "border-box",
        fontFamily: "system-ui, sans-serif",
        color: "#222",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        <h1 style={{ fontSize: "1.6rem", margin: "0 0 16px", textAlign: "center", color: "#003057" }}>
          Consent Form
        </h1>

        <div style={{ lineHeight: 1.65, fontSize: 15, color: "#333" }}>
          <p>Dear participant,</p>

          <p>
            We invite you to participate in a research study. The goal of this study is to understand
            how attitudes towards new features and technologies introduced by online services.
          </p>

          <p>
            As part of this study, you will take part in a short online focus group discussion
            followed by a brief survey about your experiences and opinions. The study will take
            approximately 20 minutes to complete. The survey is anonymous, and we will not collect
            any information that directly identifies you. The risks associated with participation
            are minimal and are no greater than those encountered in everyday online interactions.
          </p>

          <p>
            You will receive $4.00 for completing this study, which takes approximately 20 minutes,
            and will be paid through Prolific. You will not receive any direct personal benefit from
            participating.
          </p>

          <p>
            During the study, you may be led to believe some things that are not true. When the
            study is over, we will tell you everything. At that time, you may decide whether to
            allow us to use your information. You have the right to require your information be
            destroyed.
          </p>

          <p>
            To make sure that this research is being carried out in the proper way, the Georgia
            Institute of Technology IRB may review study records. The Office of Human Research
            Protections may also look at study records. If you have questions about the study, you
            may contact us at{" "}
            <a href="mailto:heeyun.kim@gatech.edu" style={{ color: "#1976d2" }}>
              heeyun.kim@gatech.edu
            </a>
            . If you have questions about your rights as a research participant, you may contact
            the Georgia Tech Office of Research Integrity Assurance at{" "}
            <a href="mailto:IRB@gatech.edu" style={{ color: "#1976d2" }}>
              IRB@gatech.edu
            </a>
            .
          </p>

          <p>
            If you complete the survey, it means that you have read — or have had read to you —
            the information contained in this letter and would like to participate in the study.
            Thank you.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Consent choice"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 14,
            justifyContent: "center",
            margin: "24px 0 16px",
          }}
        >
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              border: choice === "agree" ? "2px solid #1976d2" : "1px solid #ccc",
              borderRadius: 8,
              cursor: "pointer",
              background: choice === "agree" ? "#e8f1fb" : "#fff",
              fontSize: 15,
            }}
          >
            <input
              type="radio"
              name="consent"
              value="agree"
              checked={choice === "agree"}
              onChange={() => setChoice("agree")}
            />
            Agree to Participate
          </label>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              border: choice === "decline" ? "2px solid #c0392b" : "1px solid #ccc",
              borderRadius: 8,
              cursor: "pointer",
              background: choice === "decline" ? "#fbecea" : "#fff",
              fontSize: 15,
            }}
          >
            <input
              type="radio"
              name="consent"
              value="decline"
              checked={choice === "decline"}
              onChange={() => setChoice("decline")}
            />
            Do not agree to participate
          </label>
        </div>

        {error && (
          <p style={{ color: "#c00", textAlign: "center", margin: "0 0 12px" }}>{error}</p>
        )}

        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            onClick={handleNext}
            style={{
              padding: "12px 28px",
              fontSize: 16,
              background: "#1976d2",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              minWidth: 140,
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

export { CONSENT_KEY };
