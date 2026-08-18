// Generic error screen used for two cases (see App.jsx / AccessGuard):
//   - 400 Bad Request: the app was reached in an unsupported way — a page reload or
//     the browser back button mid-study. The study is a single-pass funnel, so
//     re-entering a page out of order is treated as a bad request.
//   - 404 Not Found: a URL that isn't part of the study flow (catch-all route).
export default function ErrorPage({
  code = "400",
  title = "Bad request",
  message = "It looks like you reloaded the page or used the browser’s back button. This study has to be completed in one continuous pass, so reloading or navigating back isn’t supported.",
}) {
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
      <h1 style={{ margin: 0, fontSize: "3rem", color: "#003057", lineHeight: 1 }}>{code}</h1>
      <h2 style={{ margin: "12px 0 8px", color: "#003057" }}>{title}</h2>
      <p style={{ color: "#444", maxWidth: 540, lineHeight: 1.6 }}>{message}</p>
      <p style={{ color: "#666", fontSize: 14, maxWidth: 540, lineHeight: 1.6, marginTop: 12 }}>
        Please don’t refresh or use the back button. If you were in the middle of the
        study, return to Prolific for further instructions.
      </p>
    </div>
  );
}
