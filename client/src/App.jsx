import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import SiteHeader from "./SiteHeader.jsx";
import ConsentPage from "./ConsentPage.jsx";
import NamePage from "./NamePage.jsx";
import WaitingPage from "./WaitingPage.jsx";
import ChatPage from "./ChatPage.jsx";
import SurveyPage from "./SurveyPage.jsx";
import CompletePage from "./CompletePage.jsx";
import LoginChoice from "./LoginChoice.jsx";
import ErrorPage from "./ErrorPage.jsx";
import { isReloadOrBackForwardEntry, isUnloadAllowed } from "./navGuard.js";

// Shown in the native confirm() dialog when the participant presses the browser Back
// OR Forward button. (Browsers don't allow the reload-style beforeunload dialog to
// fire on an in-app history navigation, so confirm() is the built-in warning we can
// show there.)
const NAV_WARNING = "You may lose your progress if you leave this page. Are you sure?";

// Pages the participant actively moves through. Reloading or pressing back on any of
// these is treated as "incorrect access" and routed to ErrorPage. (Consent "/" is
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
// protected page? If so we render ErrorPage instead of the real route, so a
// reloaded /chat never re-mounts (and never tries to rejoin), a re-entered /survey
// never restarts, etc. In-app navigation keeps type "navigate", so the normal
// funnel is unaffected — this only trips on an actual reload or browser back/forward.
const BLOCKED_ON_ENTRY =
  isReloadOrBackForwardEntry() &&
  !isTerminalScreen(window.location.pathname, window.location.search);

// Installed on protected pages: traps the browser Back button (-> ErrorPage) and
// warns before reload/close ("you may lose your progress"). Lives inside the router
// so it can useNavigate/useLocation.
function AccessGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const isProtected =
    PROTECTED_PATHS.has(location.pathname) &&
    !isTerminalScreen(location.pathname, location.search);

  // Remember the last committed in-app location so a cancelled back/forward can be
  // undone (restores the exact page they were on before pressing the button).
  const lastLocationRef = useRef(location.pathname + location.search);
  useEffect(() => {
    lastLocationRef.current = location.pathname + location.search;
  }, [location]);

  // Trap the browser Back AND Forward buttons app-wide. popstate fires only for those
  // buttons (React Router's navigate() uses push/replaceState, which don't fire it),
  // so every popstate here is a real back/forward press — including a forward press
  // that would re-enter the app after a back. Warn with the built-in confirm() dialog;
  // on confirm go to the blocked page, on cancel restore the page they were on (so a
  // cancelled forward can't sneak them back in). The sentinel pushed on mount keeps a
  // back press in-app (firing popstate) instead of unloading the document.
  useEffect(() => {
    window.history.pushState(null, "", window.location.href);
    const onPop = () => {
      if (isUnloadAllowed()) return; // a legitimate exit is already in progress
      if (window.confirm(NAV_WARNING)) {
        navigate("/blocked", { replace: true });
      } else {
        navigate(lastLocationRef.current, { replace: true });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigate]);

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
        <ErrorPage />
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
            <Route path="/blocked" element={<ErrorPage />} />
            <Route
              path="*"
              element={
                <ErrorPage
                  code="404"
                  title="Page not found"
                  message="This page doesn’t exist or isn’t part of the study."
                />
              }
            />
          </Routes>
        </>
      )}
    </BrowserRouter>
  );
}
