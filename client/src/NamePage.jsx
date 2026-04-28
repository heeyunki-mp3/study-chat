import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "participantName";
const PROFILE_PICTURE_KEY = "participantProfilePicture";
const PROFILE_SIZE = 128;

export default function NamePage() {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [stream, setStream] = useState(null);
  const [cameraRequested, setCameraRequested] = useState(false);
  const videoRef = useRef(null);

  // Parse and store Prolific URL params on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prolificPid = params.get("PROLIFIC_PID");
    const studyId = params.get("STUDY_ID");
    const prolificSessionId = params.get("SESSION_ID");
    if (prolificPid) sessionStorage.setItem("PROLIFIC_PID", prolificPid);
    if (studyId) sessionStorage.setItem("STUDY_ID", studyId);
    if (prolificSessionId) sessionStorage.setItem("PROLIFIC_SESSION_ID", prolificSessionId);
  }, []);
  const streamRef = useRef(null);
  const navigate = useNavigate();

  function requestCamera() {
    setCameraError(null);
    setCameraRequested(true);
    const promise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 320 } },
    });
    let settled = false;
    const reset = () => {
      if (settled) return;
      settled = true;
      setCameraError("Permission denied. Allow camera in browser settings (lock icon in address bar), then click Allow camera.");
      setCameraRequested(false);
    };
    const timeout = setTimeout(reset, 5000);
    promise
      .then((s) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        setStream(s);
        setCameraError(null);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        setCameraError("Permission denied. Allow camera in browser settings (lock icon in address bar), then click Allow camera.");
        setCameraRequested(false);
      });
  }

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Auto-open camera if permission was already granted (e.g. previous visit or retake)
  useEffect(() => {
    if (capturedPhoto || stream) return;
    const check = async () => {
      try {
        const perm = await navigator.permissions?.query({ name: "camera" });
        if (perm?.state === "granted") requestCamera();
      } catch {
        // Permissions API not supported (e.g. Safari) - show button
      }
    };
    check();
  }, [capturedPhoto]);

  useEffect(() => {
    if (!videoRef.current || !stream) return;
    videoRef.current.srcObject = stream;
  }, [stream]);

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || !stream) return;
    const canvas = document.createElement("canvas");
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = PROFILE_SIZE;
    canvas.height = PROFILE_SIZE;
    const ctx = canvas.getContext("2d");
    const size = Math.min(w, h);
    const sx = (w - size) / 2;
    const sy = (h - size) / 2;
    ctx.drawImage(video, sx, sy, size, size, 0, 0, PROFILE_SIZE, PROFILE_SIZE);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setCapturedPhoto(dataUrl);
    // Close camera after capture
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setCameraRequested(false);
  }

  function retakePhoto() {
    setCapturedPhoto(null);
    setCameraError(null);
    // Reopen camera if they had it before (permission already granted)
    requestCamera();
  }

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = (name || "").trim();
    if (!trimmed) {
      setError("Please enter your name.");
      return;
    }
    setError("");
    try {
      sessionStorage.setItem(STORAGE_KEY, trimmed);
      if (capturedPhoto) {
        sessionStorage.setItem(PROFILE_PICTURE_KEY, capturedPhoto);
      } else {
        try {
          sessionStorage.removeItem(PROFILE_PICTURE_KEY);
        } catch {}
      }
    } catch {
      setError("Could not save name.");
      return;
    }
    // Clear flow flags from any previous session
    sessionStorage.removeItem("passedWaiting");
    sessionStorage.removeItem("chatCompleted");
    sessionStorage.removeItem("studySessionId");
    navigate("/waiting", { replace: true });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 8, fontSize: "1.5rem" }}>Welcome</h1>
      <p style={{ color: "#666", marginBottom: 24, textAlign: "center" }}>Please enter your name and take a profile photo to join the discussion.</p>

      {/* Profile photo capture */}
      <div
        style={{
          width: 160,
          height: 160,
          borderRadius: "50%",
          overflow: "hidden",
          background: "#e0e0e0",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid #ccc",
        }}
      >
        {capturedPhoto ? (
          <img src={capturedPhoto} alt="Profile" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : stream && !cameraError ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
          />
        ) : (
          <button
            type="button"
            onClick={requestCamera}
            disabled={cameraRequested && !stream}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#1976d2",
              color: "#fff",
              border: "none",
              cursor: cameraRequested && !stream ? "wait" : "pointer",
              opacity: cameraRequested && !stream ? 0.8 : 1,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            {cameraRequested && !stream ? "Loading…" : "Allow camera"}
          </button>
        )}
      </div>
      {cameraError && !stream && (
        <p style={{ color: "#c00", fontSize: 13, marginTop: -8, marginBottom: 16, textAlign: "center", maxWidth: 280 }}>
          {cameraError}
        </p>
      )}
      {!capturedPhoto && stream && !cameraError && (
        <button
          type="button"
          onClick={capturePhoto}
          style={{
            marginBottom: 20,
            padding: "10px 20px",
            fontSize: 14,
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Take photo
        </button>
      )}
      {capturedPhoto && (
        <button
          type="button"
          onClick={retakePhoto}
          style={{
            marginBottom: 20,
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            color: "#666",
            border: "1px solid #ccc",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Retake photo
        </button>
      )}

      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 320 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 16,
            border: "1px solid #ccc",
            borderRadius: 8,
            marginBottom: 8,
            boxSizing: "border-box",
          }}
        />
        {error && (
          <p style={{ color: "#c00", fontSize: 14, marginBottom: 8 }}>{error}</p>
        )}
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 16,
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}

export { STORAGE_KEY, PROFILE_PICTURE_KEY };
