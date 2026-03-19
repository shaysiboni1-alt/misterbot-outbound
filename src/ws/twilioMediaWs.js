// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { startCallRecording } = require("../utils/twilioRecordings");
const { setRecordingForCall } = require("../utils/recordingRegistry");
const { getSSOT } = require("../ssot/ssotClient");
const { getCallerProfile } = require("../memory/callerMemory");
const {
  waitForPrewarmReady,
  markPrewarmAttached,
} = require("../outbound/prewarmStore");

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;
    let customParameters = {};
    let gemini = null;
    let stopped = false;
    let openingLock = false;
    let openingMarkName = "";
    let openingLockTimer = null;
    const pendingInboundFrames = [];

    function sendJson(obj) {
      try {
        twilioWs.send(JSON.stringify(obj));
      } catch {}
    }

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid || !ulaw8kB64) return;
      sendJson({
        event: "media",
        streamSid,
        media: { payload: ulaw8kB64 },
      });
    }

    function sendTwilioMark(name) {
      if (!streamSid || !name) return;
      sendJson({
        event: "mark",
        streamSid,
        mark: { name },
      });
    }

    function unlockOpeningAndFlush() {
      if (!openingLock) return;
      openingLock = false;

      if (openingLockTimer) {
        clearTimeout(openingLockTimer);
        openingLockTimer = null;
      }

      while (pendingInboundFrames.length && gemini) {
        const b64 = pendingInboundFrames.shift();
        gemini.sendUlaw8kFromTwilio(b64);
      }
    }

    twilioWs.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        customParameters = msg?.start?.customParameters || {};
        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        if (env.MB_ENABLE_RECORDING && callSid) {
          startCallRecording(callSid, logger)
            .then((r) => {
              if (r?.ok && r?.recordingSid) {
                setRecordingForCall(callSid, { recordingSid: r.recordingSid });
                logger.info("Recording started + stored in registry", {
                  callSid,
                  recordingSid: r.recordingSid,
                });
              } else {
                logger.info("Recording start skipped/failed (best-effort)", {
                  callSid,
                  ok: r?.ok,
                  reason: r?.reason || null,
                });
              }
            })
            .catch((e) => {
              logger.warn("Failed to start call recording", { callSid, err: e?.message || String(e) });
            });
        }

        const ssot = getSSOT();
        const prewarmKey = String(customParameters?.prewarm_key || "").trim();
        let prewarm = null;

        if (prewarmKey) {
          prewarm = await waitForPrewarmReady(prewarmKey, 1800, 25);
        }

        const meta = {
          streamSid,
          callSid,
          caller: customParameters?.caller,
          called: customParameters?.called,
          source: customParameters?.source,
          call_type: customParameters?.call_type || "inbound",
          lead_id: customParameters?.lead_id || "",
          campaign_id: customParameters?.campaign_id || "",
          contact_name: customParameters?.contact_name || "",
          business_name: customParameters?.business_name || "",
          prewarm_key: prewarmKey,
          spoken_opening: prewarm?.ready ? String(prewarm?.openingText || "") : "",
          skip_proactive_opening: !!prewarm?.ready,
        };

        try {
          const prof = await getCallerProfile(meta.caller);
          if (prof) meta.caller_profile = prof;
        } catch {}

        gemini = new GeminiLiveSession({
          meta,
          ssot,
          onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
          onGeminiText: (t) => logger.debug("Gemini text", { streamSid, callSid, t }),
          onTranscript: ({ who, text }) => {
            logger.info(`TRANSCRIPT ${who}`, { streamSid, callSid, text });
          },
        });
        gemini.start();

        if (prewarm?.ready && Array.isArray(prewarm.openingAudioChunks) && prewarm.openingAudioChunks.length) {
          openingLock = true;
          openingMarkName = `opening-${streamSid}`;

          for (const chunk of prewarm.openingAudioChunks) {
            sendToTwilioMedia(chunk);
          }

          sendTwilioMark(openingMarkName);
          markPrewarmAttached(prewarmKey);

          logger.info("Prewarmed opening flushed", {
            streamSid,
            callSid,
            prewarm_key: prewarmKey,
            chunks: prewarm.openingAudioChunks.length,
          });

          openingLockTimer = setTimeout(() => unlockOpeningAndFlush(), 4000);
        }

        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (!b64 || !gemini) return;

        if (openingLock) {
          pendingInboundFrames.push(b64);
          return;
        }

        gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "mark") {
        if (msg?.mark?.name && msg.mark.name === openingMarkName) {
          logger.info("Twilio opening mark received", {
            streamSid,
            callSid,
            mark: openingMarkName,
          });
          unlockOpeningAndFlush();
        }
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        unlockOpeningAndFlush();

        if (!stopped && gemini) {
          stopped = true;
          gemini.endInput();
          gemini.stop();
        }
        return;
      }

      if (ev === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      unlockOpeningAndFlush();

      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      unlockOpeningAndFlush();

      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
