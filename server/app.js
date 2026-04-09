// Passenger/Plesk wrapper — loads ESM index.js
import("./index.js").catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
