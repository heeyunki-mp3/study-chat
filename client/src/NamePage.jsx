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
  const videoRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    let s = null;
    (async () => {
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 320 } } });
        setStream(s);
        setCameraError(null);
      } catch (e) {
        setCameraError(e?.message || "Could not access camera.");
      }
    })();
    return () => {
      if (s) {
        s.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

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
  }

  function retakePhoto() {
    setCapturedPhoto(null);
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
      <p style={{ color: "#666", marginBottom: 24 }}>Please enter your name and take a profile photo to join the discussion.</p>

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
          <span style={{ color: "#888", fontSize: 14, textAlign: "center", padding: 8 }}>
            {cameraError || "Loading camera…"}
          </span>
        )}
      </div>
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
