import { BrowserRouter, Routes, Route } from "react-router-dom";
import NamePage from "./NamePage.jsx";
import WaitingPage from "./WaitingPage.jsx";
import ChatPage from "./ChatPage.jsx";
import LoginChoice from "./LoginChoice";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<NamePage />} />
        <Route path="/waiting" element={<WaitingPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/login" element={<LoginChoice />} />
      </Routes>
    </BrowserRouter>
  );
}