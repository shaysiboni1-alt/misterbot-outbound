"use strict";

const express = require("express");
const path = require("path");

const { env } = require("./config/env");
const { logger } = require("./utils/logger");

const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { recordingsRouter } = require("./routes/recordings");
const { twilioStatusRouter } = require("./routes/twilioStatus");
const { twilioVoiceRouter } = require("./routes/twilioVoice");
const { outboundAdminRouter } = require("./routes/outboundAdmin");

const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");

const { ensureCallerMemorySchema } = require("./memory/callerMemory");
const { setRecordingForCall } = require("./utils/recordingRegistry");
const { proxyRecordingMp3 } = require("./utils/twilioRecordings");
const { startScheduler } = require("./outbound/outboundScheduler");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const recordingsDir = process.env.LOCAL_RECORDINGS_DIR || path.join(__dirname, "..", "recordings");
app.use("/recordings", express.static(recordingsDir));
app.get("/", (req, res) => { res.status(200).send("ok"); });

app.use(healthRouter);
app.use(adminReloadRouter);
app.use(twilioStatusRouter);
app.use(recordingsRouter);
app.use(twilioVoiceRouter);
app.use(outboundAdminRouter);

app.get("/recording/:sid.mp3", async (req, res) => {
  const sid = String(req.params.sid || "").trim();
  if (!sid) return res.status(400).send("missing_sid");
  try {
    await proxyRecordingMp3(sid, res, logger);
  } catch (e) {
    logger.warn("recording proxy failed", { err: String(e) });
    if (!res.headersSent) res.status(500).send("proxy_error");
  }
});

app.post("/twilio-recording-callback", (req, res) => {
  try {
    const callSid = String(req.body?.CallSid || "").trim();
    const recordingSid = String(req.body?.RecordingSid || "").trim();
    const recordingUrl = String(req.body?.RecordingUrl || "").trim();
    if (callSid) {
      setRecordingForCall(callSid, { recordingSid: recordingSid || null, recordingUrl: recordingUrl || null });
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.warn("twilio-recording-callback error", { err: String(e) });
    res.status(200).json({ ok: true });
  }
});

app.use((req, res) => { res.status(404).json({ error: "not_found" }); });

const server = app.listen(env.PORT, "0.0.0.0", async () => {
  logger.info("Service started", { port: env.PORT, provider_mode: env.PROVIDER_MODE, outbound_enabled: env.OUTBOUND_ENABLED });
  try { await loadSSOT(false); } catch (err) { logger.error("SSOT preload failed", { error: err?.message || String(err) }); }
  try { await ensureCallerMemorySchema(); logger.info("Caller memory schema ready"); } catch (err) { logger.warn("Caller memory schema init failed", { error: err?.message || String(err) }); }
  if (env.OUTBOUND_ENABLED) startScheduler();
});

installTwilioMediaWs(server);
