import "./SurveyPage.css";

export default function SurveyPage() {
  return (
    <div className="survey-page">
      <div className="survey-header">
        <h2>Pilot Survey</h2>
        <p>Please complete the following survey before you go.</p>
      </div>
      <iframe
        src="https://qualtricsxml5jbfgkjs.qualtrics.com/jfe/form/SV_1LBmGog10Hsu6r4"
        className="survey-iframe"
        title="Study Survey"
        allow="fullscreen"
      />
    </div>
  );
}
