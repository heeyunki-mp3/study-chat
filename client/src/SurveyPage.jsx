import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./SurveyPage.css";

const QUALTRICS_BASE = "https://gatech.co1.qualtrics.com/jfe/form/SV_bPBOLqFJFN18XtQ";

export default function SurveyPage() {
  const navigate = useNavigate();

  const sessionId = useMemo(() => sessionStorage.getItem("chatCompleted") || "", []);

  // Guard: must come from chat page with a valid session
  useEffect(() => {
    if (!sessionId) {
      navigate("/", { replace: true });
      return;
    }
  }, [navigate, sessionId]);

  // If user presses back, send them to "/" (new session) instead of chat
  useEffect(() => {
    window.history.replaceState(null, "", "/survey");
    window.history.pushState(null, "", "/survey");
    const onBack = () => {
      navigate("/", { replace: true });
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [navigate]);

  const surveyUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (sessionId && sessionId !== "1") params.set("CHAT_SESSION_ID", sessionId);
    const prolificPid = sessionStorage.getItem("PROLIFIC_PID");
    const studyId = sessionStorage.getItem("STUDY_ID");
    const prolificSessionId = sessionStorage.getItem("PROLIFIC_SESSION_ID");
    if (prolificPid) params.set("PROLIFIC_PID", prolificPid);
    if (studyId) params.set("STUDY_ID", studyId);
    if (prolificSessionId) params.set("PROLIFIC_SESSION_ID", prolificSessionId);
    const qs = params.toString();
    return qs ? `${QUALTRICS_BASE}?${qs}` : QUALTRICS_BASE;
  }, [sessionId]);

  return (
    <div className="survey-page">
      <div className="survey-header">
        <h2>Pilot Survey</h2>
        <p>Please complete the following survey before you go.</p>
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
