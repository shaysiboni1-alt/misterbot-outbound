"use strict";

const crypto = require("crypto");
const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { pcm24kB64ToUlaw8kB64 } = require("../vendor/twilioGeminiAudio");
const { getCachedOpening } = require("../logic/openingBuilder");
const {
  createPrewarmEntry,
  markPrewarmReady,
  markPrewarmFailed,
} = require("./prewarmStore");

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function normalizeModelName(m) {
  if (!m) return "";
  return m.startsWith("models/") ? m : `models/${m}`;
}

function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

function buildOpeningPack({ lead, ssot, callType = "outbound" }) {
  const callerName = safeStr(lead?.contact_name);
  const businessName = safeStr(lead?.business_name);
  const isReturning = false;

  return getCachedOpening({
    ssot,
    callerName,
    businessName,
    isReturning,
    callType,
    timeZone: env.TIME_ZONE || "Asia/Jerusalem",
    ttlMs: Number(env.MB_OPENING_CACHE_TTL_MS || 300000),
  });
}

function buildPrewarmKickoff(openingText) {
  const opening = safeStr(openingText).replace(/\s{2,}/g, " ").trim();
  return [
    "ענה עכשיו רק במשפט הבא, בדיוק כפי שהוא, בלי הקדמה, בלי הסבר ובלי שום טקסט נוסף.",
    "חובה לענות בעברית בלבד.",
    "אסור לענות במילה אחת, בשם בלבד, או באנגלית.",
    "אחרי המשפט עצור ואל תמשיך לדבר.",
    opening,
  ].join("\n");
}

function buildPrewarmSetup(ssot) {
  return {
    setup: {
      model: normalizeModelName(env.GEMINI_LIVE_MODEL),
      generationConfig: {
        responseModalities: ["AUDIO"],
        temperature: 0.1,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName:
                env.VOICE_NAME_OVERRIDE ||
                safeStr(ssot?.settings?.VOICE_NAME) ||
                "Kore",
            },
          },
        },
      },
    },
  };
}

function preparePrewarmedOpening({ lead, ssot, callType = "outbound" }) {
  const prewarmKey = crypto.randomUUID();
  const openingPack = buildOpeningPack({ lead, ssot, callType });
  const openingText = safeStr(openingPack.opening);
  const ws = new WebSocket(liveWsUrl());

  createPrewarmEntry({
    key: prewarmKey,
    openingText,
    callType,
    meta: {
      lead_id: safeStr(lead?.lead_id),
      contact_name: safeStr(lead?.contact_name),
      business_name: safeStr(lead?.business_name),
      campaign_id: safeStr(lead?.campaign_id),
    },
    ttlMs: 2 * 60 * 1000,
    dispose: () => {
      try {
        ws.close();
      } catch {}
    },
  });

  let sentKickoff = false;
  let finished = false;
  let finalizeTimer = null;
  const audioChunks = [];

  function finish(ok, errorMessage = "") {
    if (finished) return;
    finished = true;

    if (finalizeTimer) clearTimeout(finalizeTimer);

    if (ok && audioChunks.length) {
      markPrewarmReady(prewarmKey, audioChunks);
      logger.info("Prewarmed opening ready", {
        prewarm_key: prewarmKey,
        lead_id: safeStr(lead?.lead_id),
        chunks: audioChunks.length,
        opening_len: openingText.length,
      });
    } else {
      markPrewarmFailed(prewarmKey, errorMessage || "no_audio_generated");
      logger.warn("Prewarmed opening failed", {
        prewarm_key: prewarmKey,
        lead_id: safeStr(lead?.lead_id),
        error: errorMessage || "no_audio_generated",
      });
    }

    try {
      ws.close();
    } catch {}
  }

  function armFinalizeSoon() {
    if (finalizeTimer) clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => finish(audioChunks.length > 0), 180);
  }

  ws.on("open", () => {
    try {
      ws.send(JSON.stringify(buildPrewarmSetup(ssot)));
    } catch (e) {
      finish(false, e?.message || String(e));
    }
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (!sentKickoff && (msg?.setupComplete || msg?.serverContent)) {
      sentKickoff = true;
      try {
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: buildPrewarmKickoff(openingText) }] }],
            turnComplete: true,
          },
        }));
      } catch (e) {
        finish(false, e?.message || String(e));
      }
    }

    try {
      const parts =
        msg?.serverContent?.modelTurn?.parts ||
        msg?.serverContent?.turn?.parts ||
        msg?.serverContent?.parts ||
        [];

      for (const p of parts) {
        const inline = p?.inlineData;
        if (inline?.data && String(inline?.mimeType || "").startsWith("audio/pcm")) {
          const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
          if (ulawB64) {
            audioChunks.push(ulawB64);
            armFinalizeSoon();
          }
        }
      }

      if (msg?.serverContent?.turnComplete || msg?.serverContent?.generationComplete) {
        armFinalizeSoon();
      }
    } catch (e) {
      finish(false, e?.message || String(e));
    }
  });

  ws.on("error", (err) => finish(false, err?.message || String(err)));
  ws.on("close", () => {
    if (!finished) finish(audioChunks.length > 0, audioChunks.length ? "" : "socket_closed");
  });

  setTimeout(() => {
    if (!finished) finish(audioChunks.length > 0, "prewarm_timeout");
  }, 12000);

  return { prewarmKey, openingText };
}

module.exports = { preparePrewarmedOpening };
