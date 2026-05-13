import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "participantName";
const PROFILE_PICTURE_KEY = "participantProfilePicture";
const PROFILE_SIZE = 128;
const SERVER_BASE = import.meta.env.DEV ? "http://127.0.0.1:3001" : "";

// Carousel sizing
const ITEM_SIZE = 140;
const ITEM_GAP = 24;
const STEP = ITEM_SIZE + ITEM_GAP;
const PRESET_COUNT = 3;
const PRESET_POOL = 9;

function pickRandomPresets(n, pool) {
  const arr = Array.from({ length: pool }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

export default function NamePage() {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [stream, setStream] = useState(null);
  const [cameraRequested, setCameraRequested] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const presetIds = useMemo(() => pickRandomPresets(PRESET_COUNT, PRESET_POOL), []);
  const items = useMemo(
    () => [
      { type: "camera" },
      ...presetIds.map((n) => ({ type: "preset", url: `${SERVER_BASE}/profile_pictures/profile_${n}.jpg` })),
    ],
    [presetIds]
  );
  const videoRef = useRef(null);

  const streamRef = useRef(null);
  const navigate = useNavigate();

  // Gate: require consent before showing the welcome page
  useEffect(() => {
    if (sessionStorage.getItem("participantConsent") !== "agreed") {
      navigate("/", { replace: true });
    }
  }, [navigate]);

  // Parse and store Prolific URL params on first load (kept for direct hits to /welcome)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prolificPid = params.get("PROLIFIC_PID");
    const studyId = params.get("STUDY_ID");
    const prolificSessionId = params.get("SESSION_ID");
    if (prolificPid) sessionStorage.setItem("PROLIFIC_PID", prolificPid);
    if (studyId) sessionStorage.setItem("STUDY_ID", studyId);
    if (prolificSessionId) sessionStorage.setItem("PROLIFIC_SESSION_ID", prolificSessionId);
  }, []);

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
    if (capturedPhoto || stream || activeIndex !== 0) return;
    const check = async () => {
      try {
        const perm = await navigator.permissions?.query({ name: "camera" });
        if (perm?.state === "granted") requestCamera();
      } catch {
        // Permissions API not supported (e.g. Safari) - show button
      }
    };
    check();
  }, [capturedPhoto, activeIndex]);

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

  function selectIndex(i) {
    if (i === activeIndex) return;
    const target = items[i];
    setActiveIndex(i);
    if (target.type === "preset") {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setStream(null);
      setCameraRequested(false);
      setCameraError(null);
      setCapturedPhoto(target.url);
    } else {
      // Switching back to camera item — discard a preset URL but keep an actual captured dataURL
      if (capturedPhoto && !capturedPhoto.startsWith("data:")) {
        setCapturedPhoto(null);
      }
    }
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
        height: "calc(100vh - 61px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px 24px",
        boxSizing: "border-box",
        overflow: "hidden",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: "1.5rem" }}>Welcome</h1>
      <p style={{ color: "#666", margin: 0, marginBottom: 16, textAlign: "center" }}>
        Enter your name and pick a profile
        <br />
        Take a photo or choose an icon to the right.
      </p>

      {/* Carousel: [camera | preset | preset | preset] */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: ITEM_SIZE + 16,
          overflow: "hidden",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: `translate(calc(-${ITEM_SIZE / 2}px - ${activeIndex * STEP}px), -50%)`,
            display: "flex",
            gap: `${ITEM_GAP}px`,
            alignItems: "center",
            transition: "transform 0.35s ease",
          }}
        >
          {items.map((item, i) => {
            const distance = Math.abs(i - activeIndex);
            const opacity = Math.max(0, Math.min(1, (2.5 - distance) / 1));
            const scale = Math.max(0.55, 1 - distance * 0.12);
            const isActive = i === activeIndex;
            const isCamera = item.type === "camera";
            return (
              <div
                key={i}
                onClick={() => selectIndex(i)}
                role="button"
                aria-label={isCamera ? "Camera photo" : `Preset profile icon ${i}`}
                style={{
                  width: ITEM_SIZE,
                  height: ITEM_SIZE,
                  borderRadius: "50%",
                  overflow: "hidden",
                  background: "#e0e0e0",
                  border: isActive ? "2px solid #1976d2" : "2px solid #ccc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: isActive ? "default" : "pointer",
                  opacity,
                  transform: `scale(${scale})`,
                  transition: "opacity 0.35s ease, transform 0.35s ease, border-color 0.2s ease",
                  flexShrink: 0,
                  pointerEvents: opacity < 0.1 ? "none" : "auto",
                }}
              >
                {isCamera ? (
                  capturedPhoto && capturedPhoto.startsWith("data:") ? (
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
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isActive) {
                          selectIndex(i);
                          return;
                        }
                        requestCamera();
                      }}
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
                        borderRadius: 0,
                        cursor: cameraRequested && !stream ? "wait" : "pointer",
                        opacity: cameraRequested && !stream ? 0.8 : 1,
                        fontSize: 14,
                        fontWeight: 500,
                        padding: 0,
                      }}
                    >
                      {cameraRequested && !stream ? "Loading…" : "Allow camera"}
                    </button>
                  )
                ) : (
                  <img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} draggable={false} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {cameraError && activeIndex === 0 && !stream && (
        <p style={{ color: "#c00", fontSize: 13, margin: "0 0 12px", textAlign: "center", maxWidth: 280 }}>
          {cameraError}
        </p>
      )}
      {activeIndex === 0 && !capturedPhoto && stream && !cameraError && (
        <button
          type="button"
          onClick={capturePhoto}
          style={{
            marginBottom: 12,
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
      {activeIndex === 0 && capturedPhoto && capturedPhoto.startsWith("data:") && (
        <button
          type="button"
          onClick={retakePhoto}
          style={{
            marginBottom: 12,
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
