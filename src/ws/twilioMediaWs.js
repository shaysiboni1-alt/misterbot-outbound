// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { startCallRecording } = require("../utils/twilioRecordings");
const { setRecordingForCall } = require("../utils/recordingRegistry");
const { getSSOT } = require("../ssot/ssotClient");
const { mark, setMeta } = require("../utils/callTiming");

const { getCallerProfile } = require("../memory/callerMemory");

function b64ToBuf(b64) {
  try {
    return Buffer.from(String(b64 || ""), "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function bufToB64(buf) {
  return Buffer.from(buf || Buffer.alloc(0)).toString("base64");
}

function createTwilioAudioSender({ twilioWs, getStreamSid, getCallSid }) {
  const FIRST_PACKET_BYTES = 160; // ~20ms @ 8k ulaw
  const NORMAL_PACKET_BYTES = 640;

  let firstMediaSent = false;
  let queue = [];
  let flushing = false;

  function sendPacket(packetBuf, reason) {
    const streamSid = getStreamSid();
    const callSid = getCallSid();
    if (!streamSid || !packetBuf?.length) return false;

    const payload = {
      event: "media",
      streamSid,
      media: { payload: bufToB64(packetBuf) },
    };

    try {
      twilioWs.send(JSON.stringify(payload));
      const markMeta = {
        first_packet_bytes: packetBuf.length,
        reason,
      };
      mark(callSid, streamSid, "first_twilio_media_sent", markMeta);
      if (!firstMediaSent) {
        firstMediaSent = true;
        logger.info("FIRST_TWILIO_MEDIA_SENT", {
          callSid,
          streamSid,
          bytes: packetBuf.length,
          reason,
          queued_packets_after_send: queue.length,
        });
      }
      return true;
    } catch (error) {
      logger.debug("Failed sending Twilio media packet", {
        callSid,
        streamSid,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const packet = queue.shift();
        if (!sendPacket(packet, "queued")) break;
      }
    } finally {
      flushing = false;
    }
  }

  return function sendUlawToTwilio(ulaw8kB64) {
    const ulawBuf = b64ToBuf(ulaw8kB64);
    if (!ulawBuf.length) return;

    if (!firstMediaSent) {
      const firstPacket = ulawBuf.subarray(0, Math.min(FIRST_PACKET_BYTES, ulawBuf.length));
      const rest = ulawBuf.subarray(firstPacket.length);
      sendPacket(firstPacket, "first_packet_fast_path");
      for (let offset = 0; offset < rest.length; offset += NORMAL_PACKET_BYTES) {
        queue.push(rest.subarray(offset, Math.min(offset + NORMAL_PACKET_BYTES, rest.length)));
      }
      if (queue.length) setImmediate(flushQueue);
      return;
    }

    if (ulawBuf.length <= NORMAL_PACKET_BYTES) {
      queue.push(ulawBuf);
    } else {
      for (let offset = 0; offset < ulawBuf.length; offset += NORMAL_PACKET_BYTES) {
        queue.push(ulawBuf.subarray(offset, Math.min(offset + NORMAL_PACKET_BYTES, ulawBuf.length)));
      }
    }

    setImmediate(flushQueue);
  };
}


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

    const sendToTwilioMedia = createTwilioAudioSender({
      twilioWs,
      getStreamSid: () => streamSid,
      getCallSid: () => callSid,
    });

    // NOTE: must be async because we may await caller-memory lookups (Postgres).
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
        mark(callSid, streamSid, "twilio_stream_start", {
          lead_id: customParameters?.lead_id || "",
          contact_name: customParameters?.contact_name || "",
          business_name: customParameters?.business_name || "",
          source: customParameters?.source || "",
          call_type: customParameters?.call_type || "",
        });
        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        // Start Twilio call recording early so a RecordingSid exists by the time we finalize.
        // Canonical spec: if Twilio returns a sid, store it immediately in Registry by CallSid.
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

        const ssot = getSSOT(); // already loaded; if empty do not break voice

        const meta = {
          streamSid,
          callSid,
          caller: customParameters?.caller,
          called: customParameters?.called,
          source: customParameters?.source,
          call_type: customParameters?.call_type || 'inbound',
          lead_id: customParameters?.lead_id || '',
          campaign_id: customParameters?.campaign_id || '',
          contact_name: customParameters?.contact_name || '',
          business_name: customParameters?.business_name || '',
        };

        setMeta(callSid, streamSid, {
          caller: meta.caller || '',
          called: meta.called || '',
          source: meta.source || '',
          call_type: meta.call_type || '',
          lead_id: meta.lead_id || '',
          campaign_id: meta.campaign_id || '',
          contact_name: meta.contact_name || '',
          business_name: meta.business_name || '',
        });

        // Best-effort caller recognition. No impact on lead parsing.
        try {
          const prof = await getCallerProfile(meta.caller);
          if (prof) meta.caller_profile = prof;
        } catch (e) {
          // swallow
        }

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
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (b64 && gemini) gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        mark(callSid, streamSid, "call_closed");
        logger.info("Twilio stream stop", { streamSid, callSid });
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
      mark(callSid, streamSid, "call_closed");
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });

    twilioWs.on("error", (err) => {
      mark(callSid, streamSid, "call_closed");
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
