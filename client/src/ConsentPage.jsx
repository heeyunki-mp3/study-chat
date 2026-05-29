import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const CONSENT_KEY = "participantConsent";

export default function ConsentPage() {
  const [choice, setChoice] = useState(null); // "agree" | "decline" | null
  const [error, setError] = useState("");
  // Kicked participants are redirected here with ?declined=1 so they land on the
  // same "you will not proceed" screen shown when consent is declined.
  const [declined, setDeclined] = useState(
    () => new URLSearchParams(window.location.search).get("declined") === "1"
  );
  const navigate = useNavigate();

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
      setDeclined(true);
    }
  }

  if (declined) {
    return (
      <div
        style={{
          minHeight: "calc(100vh - 61px)",
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
          Since you did not agree to participate, you will not proceed to the next step.
          Please close this page.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "calc(100vh - 61px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
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
            approximately 15 minutes to complete. The survey is anonymous, and we will not collect
            any information that directly identifies you. The risks associated with participation
            are minimal and are no greater than those encountered in everyday online interactions.
          </p>

          <p>
            You will receive $3.00 for completing this study, which takes approximately 15 minutes,
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
