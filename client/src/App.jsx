import { BrowserRouter, Routes, Route } from "react-router-dom";
import NamePage from "./NamePage.jsx";
import WaitingPage from "./WaitingPage.jsx";
import ChatPage from "./ChatPage.jsx";
import SurveyPage from "./SurveyPage.jsx";
import LoginChoice from "./LoginChoice.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<NamePage />} />
        <Route path="/waiting" element={<WaitingPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/survey" element={<SurveyPage />} />
        <Route path="/login-choice" element={<LoginChoice />} />
      </Routes>
    </BrowserRouter>
  );
}