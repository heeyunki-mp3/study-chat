import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { permitUnload } from "./navGuard.js";
import "./SurveyPage.css";

const QUALTRICS_BASE = "https://gatech.co1.qualtrics.com/jfe/form/SV_0v6cwB6aynkwgTQ";
const PROLIFIC_COMPLETE_URL = "https://app.prolific.com/submissions/complete?cc=CQVN22U3";

export default function SurveyPage() {
  const navigate = useNavigate();

  const sessionId = useMemo(() => sessionStorage.getItem("chatCompleted") || "", []);

  // Guard: must come from chat page with a valid session — and not kicked
  // (kicked users have the session flag set too, but must not reach the survey).
  useEffect(() => {
    if (!sessionId || sessionStorage.getItem("studyEnded") === "kicked") {
      navigate("/", { replace: true });
      return;
    }
  }, [navigate, sessionId]);

  // Back button / reload are handled globally by App.jsx's AccessGuard (which routes
  // them to the blocked page and warns before reload), so no per-page trap here.

  // Fallback path for Qualtrics → top-level redirect.
  // The End-of-Survey script in Qualtrics may also try `window.top.location.replace(...)`
  // directly; this postMessage listener is the safety net when the browser blocks
  // top-navigation from a cross-origin iframe without user activation.
  useEffect(() => {
    function onMessage(e) {
      // We accept any origin here — the only thing we do is navigate to a fixed URL.
      if (e?.data && e.data.type === "studyComplete") {
        // Record the successful redirect for the per-group recruitment cap.
        // keepalive lets the request finish after location.replace; the server
        // stamps first-wins, so the /complete page's duplicate beacon is harmless.
        try {
          const ctxSessionId = localStorage.getItem("sessionId") || "";
          const participantId = localStorage.getItem("participantId") || "";
          if (ctxSessionId && participantId) {
            fetch("/api/focus-group/survey-complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              keepalive: true,
              body: JSON.stringify({ sessionId: ctxSessionId, participantId }),
            }).catch(() => {});
          }
        } catch {
          // ignore — the beacon is best-effort
        }
        // Legitimate exit — suppress the global reload/close warning so it can't
        // interrupt the handoff back to Prolific.
        permitUnload();
        window.location.replace(PROLIFIC_COMPLETE_URL);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const surveyUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (sessionId && sessionId !== "1") params.set("CHAT_SESSION_ID", sessionId);
    const prolificPid = sessionStorage.getItem("PROLIFIC_PID");
    const studyId = sessionStorage.getItem("STUDY_ID");
    const prolificSessionId = sessionStorage.getItem("PROLIFIC_SESSION_ID");
    if (prolificPid) params.set("PROLIFIC_PID", prolificPid);
    if (studyId) params.set("STUDY_ID", studyId);
    if (prolificSessionId) params.set("PROLIFIC_SESSION_ID", prolificSessionId);
    // Auth method the participant registered with: "pw" (password) or "pk" (passkey).
    const pwVsPk = sessionStorage.getItem("pw_vs_pk");
    if (pwVsPk) params.set("pw_vs_pk", pwVsPk);
    // ag = blinded group code, mapped server-side (decode at analysis time).
    const ag = sessionStorage.getItem("ag");
    if (ag) params.set("ag", ag);
    const qs = params.toString();
    return qs ? `${QUALTRICS_BASE}?${qs}` : QUALTRICS_BASE;
  }, [sessionId]);

  return (
    <div className="survey-page">
      <div className="survey-header">
        <h2>Survey</h2>
        <p>
          Please complete the following survey before you go. When you submit
          it, you will be taken back to Prolific automatically to record your
          completion.
        </p>
      </div>
      <iframe
        src={surveyUrl}
        className="survey-iframe"
        title="Study Survey"
        allow="fullscreen"
      />
    </div>
  );
}
