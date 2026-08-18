import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import SiteHeader from "./SiteHeader.jsx";
import ConsentPage from "./ConsentPage.jsx";
import NamePage from "./NamePage.jsx";
import WaitingPage from "./WaitingPage.jsx";
import ChatPage from "./ChatPage.jsx";
import SurveyPage from "./SurveyPage.jsx";
import CompletePage from "./CompletePage.jsx";
import LoginChoice from "./LoginChoice.jsx";
import BlockedPage from "./BlockedPage.jsx";
import { isReloadOrBackForwardEntry, isUnloadAllowed } from "./navGuard.js";

// Pages the participant actively moves through. Reloading or pressing back on any of
// these is treated as "incorrect access" and routed to BlockedPage. (Consent "/" is
// included — but its kicked/declined end screen is exempt, see isTerminalScreen.)
const PROTECTED_PATHS = new Set(["/", "/welcome", "/waiting", "/chat", "/login", "/survey"]);

// Terminal screens that must be allowed to proceed even on a reload/back-forward:
// they auto-redirect to Prolific (completion / kick / decline codes), and blocking
// them would stop that redirect and cost the participant their payment.
function isTerminalScreen(pathname, search) {
  if (pathname === "/complete" || pathname === "/blocked") return true;
  let kicked = search.includes("kicked=1");
  const declined = search.includes("declined=1");
  try {
    kicked = kicked || sessionStorage.getItem("studyEnded") === "kicked";
  } catch {
    // sessionStorage may be unavailable — fall back to the URL param check
  }
  return pathname === "/" && (kicked || declined);
}

// Decided ONCE per document load: did we arrive via reload / back-forward onto a
// protected page? If so we render BlockedPage instead of the real route, so a
// reloaded /chat never re-mounts (and never tries to rejoin), a re-entered /survey
// never restarts, etc. In-app navigation keeps type "navigate", so the normal
// funnel is unaffected — this only trips on an actual reload or browser back/forward.
const BLOCKED_ON_ENTRY =
  isReloadOrBackForwardEntry() &&
  !isTerminalScreen(window.location.pathname, window.location.search);

// Installed on protected pages: traps the browser Back button (-> BlockedPage) and
// warns before reload/close ("you may lose your progress"). Lives inside the router
// so it can useNavigate/useLocation.
function AccessGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const isProtected =
    PROTECTED_PATHS.has(location.pathname) &&
    !isTerminalScreen(location.pathname, location.search);

  // Back button on a protected page -> blocked page.
  useEffect(() => {
    if (!isProtected) return undefined;
    window.history.pushState(null, "", window.location.href);
    const onPop = () => navigate("/blocked", { replace: true });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isProtected, navigate]);

  // Warn before reload/close on a protected page. permitUnload() (set right before a
  // legitimate Prolific redirect) suppresses it so a real exit isn't interrupted.
  useEffect(() => {
    if (!isProtected) return undefined;
    const onBeforeUnload = (e) => {
      if (isUnloadAllowed()) return undefined;
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to show the prompt
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isProtected]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SiteHeader />
      {BLOCKED_ON_ENTRY ? (
        <BlockedPage />
      ) : (
        <>
          <AccessGuard />
          <Routes>
            <Route path="/" element={<ConsentPage />} />
            <Route path="/welcome" element={<NamePage />} />
            <Route path="/waiting" element={<WaitingPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/survey" element={<SurveyPage />} />
            <Route path="/complete" element={<CompletePage />} />
            <Route path="/login" element={<LoginChoice />} />
            <Route path="/blocked" element={<BlockedPage />} />
            <Route path="*" element={<BlockedPage />} />
          </Routes>
        </>
      )}
    </BrowserRouter>
  );
}
