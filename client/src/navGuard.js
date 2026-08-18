// Shared helpers for the app-wide access guard (see App.jsx / AccessGuard).
//
// The study is a single-pass funnel. Reloading a page or using the browser
// back/forward button can corrupt a participant's in-memory session (e.g. a
// reloaded /chat would try to rejoin, a re-entered /survey would restart it), so
// the guard blocks those and shows ErrorPage instead. These helpers back that.

// Set to true right before a LEGITIMATE programmatic navigation off the app
// (the Qualtrics -> Prolific handoff, the decline/kick -> Prolific redirect).
// The global beforeunload warning checks this so a real exit is never prompted
// or interrupted. Once we're intentionally leaving, it stays true for the rest
// of the document's life, which is fine.
let unloadAllowed = false;
export function permitUnload() {
  unloadAllowed = true;
}
export function isUnloadAllowed() {
  return unloadAllowed;
}

// True when THIS document was loaded by a reload or a browser back/forward
// navigation (as opposed to a fresh "navigate"). Read once per document load
// from the Navigation Timing API, with a fallback to the legacy API. In-app
// React Router transitions do NOT change this — it reflects how the current
// document was loaded — so it only trips on an actual page reload / back-forward.
export function isReloadOrBackForwardEntry() {
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    const type = entry
      ? entry.type
      : performance.navigation && performance.navigation.type === 1
        ? "reload"
        : "navigate";
    return type === "reload" || type === "back_forward";
  } catch {
    return false;
  }
}
