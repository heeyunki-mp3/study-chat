import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "./SurveyPage.css";

const QUALTRICS_BASE = "https://qualtricsxml5jbfgkjs.qualtrics.com/jfe/form/SV_1LBmGog10Hsu6r4";

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

  const surveyUrl = sessionId && sessionId !== "1"
    ? `${QUALTRICS_BASE}?sessionId=${encodeURIComponent(sessionId)}`
    : QUALTRICS_BASE;

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
