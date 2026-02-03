import { BrowserRouter, Routes, Route } from "react-router-dom";
import ChatPage from "./ChatPage.jsx";
import LoginChoice from "./LoginChoice";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/login" element={<LoginChoice />} />
      </Routes>
    </BrowserRouter>
  );
}