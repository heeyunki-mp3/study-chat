import { BrowserRouter, Routes, Route } from "react-router-dom";
import SiteHeader from "./SiteHeader.jsx";
import ConsentPage from "./ConsentPage.jsx";
import NamePage from "./NamePage.jsx";
import WaitingPage from "./WaitingPage.jsx";
import ChatPage from "./ChatPage.jsx";
import SurveyPage from "./SurveyPage.jsx";
import CompletePage from "./CompletePage.jsx";
import LoginChoice from "./LoginChoice.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <SiteHeader />
      <Routes>
        <Route path="/" element={<ConsentPage />} />
        <Route path="/welcome" element={<NamePage />} />
        <Route path="/waiting" element={<WaitingPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/survey" element={<SurveyPage />} />
        <Route path="/complete" element={<CompletePage />} />
        <Route path="/login" element={<LoginChoice />} />
      </Routes>
    </BrowserRouter>
  );
}