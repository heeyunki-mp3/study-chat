// Shown when the app is reached in an unsupported way — a page reload, the browser
// back/forward button, or a URL that isn't part of the study flow. The study is a
// single-pass funnel (see App.jsx / AccessGuard); re-entering a page out of order
// can corrupt a participant's session, so we stop them here instead of letting the
// real page mount.
export default function BlockedPage() {
  return (
    <div
      style={{
        minHeight: "calc(100dvh - 61px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        color: "#222",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "3rem", color: "#003057", lineHeight: 1 }}>404</h1>
      <h2 style={{ margin: "12px 0 8px", color: "#003057" }}>
        This page can’t be accessed this way
      </h2>
      <p style={{ color: "#444", maxWidth: 540, lineHeight: 1.6 }}>
        It looks like you reloaded the page or used the browser’s back button. This
        study has to be completed in one continuous pass, so reloading or navigating
        back isn’t supported.
      </p>
      <p style={{ color: "#666", fontSize: 14, maxWidth: 540, lineHeight: 1.6, marginTop: 12 }}>
        Please don’t refresh or use the back button. If you were in the middle of the
        study, return to Prolific for further instructions.
      </p>
    </div>
  );
}
