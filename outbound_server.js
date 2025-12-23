/**
 * MisterBot – Outbound Realtime Voice Server
 * Twilio Media Streams <-> OpenAI Realtime
 *
 * ⚠️ שרת ייעודי לשיחות יוצאות בלבד
 * ⚠️ אין dotenv – Render מספק ENV
 */

const express = require("express");
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3000;

// ====== ENV חובה ======
const {
  OPENAI_API_KEY,
  MB_LANGUAGES,

  OUTBOUND_OPENING_SCRIPT,
  OUTBOUND_GENERAL_PROMPT,
  OUTBOUND_BUSINESS_PROMPT,
  OUTBOUND_CLOSING_SCRIPT,

  OUTBOUND_STATUS_WEBHOOK_URL,
  MB_CALL_LOG_WEBHOOK_URL
} = process.env;

if (!OPENAI_API_KEY) {
  throw new Error("❌ Missing OPENAI_API_KEY");
}

// ====== HTTP SERVER ======
const app = express();
const server = http.createServer(app);

// Healthcheck
app.get("/", (_, res) => {
  res.status(200).send("MisterBot Outbound is alive");
});

// ====== WebSocket Server (Twilio Media Streams) ======
const wss = new WebSocket.Server({
  server,
  path: "/twilio-media-stream"
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());

  const {
    direction,
    outbound_id,
    campaign,
    to,
    from
  } = params;

  console.log("📞 New WS connection", {
    direction,
    outbound_id,
    campaign,
    to,
    from
  });

  // ====== כאן בהמשך נכנסת לוגיקת OpenAI Realtime שלך ======
  // כרגע רק שלד יציב, בלי לגעת בלוגיקה הקיימת שלך

  ws.on("message", (msg) => {
    // Twilio audio / events
  });

  ws.on("close", () => {
    console.log("🔚 WS closed", outbound_id || "");
  });

  ws.on("error", (err) => {
    console.error("❌ WS error", err);
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Outbound listening on port ${PORT}`);
});
