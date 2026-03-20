"use strict";

const STORE = new Map();
const TTL_MS = 1000 * 60 * 30;

function nowMs() {
  return Date.now();
}

function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

function getKey(callSid, streamSid) {
  const c = safeStr(callSid);
  const s = safeStr(streamSid);
  return c || s || "";
}

function ensure(callSid, streamSid) {
  const key = getKey(callSid, streamSid);
  if (!key) return null;
  let row = STORE.get(key);
  if (!row) {
    row = {
      key,
      callSid: safeStr(callSid),
      streamSid: safeStr(streamSid),
      createdAt: nowMs(),
      marks: {},
      emitted: {},
      meta: {},
    };
    STORE.set(key, row);
  }
  if (callSid && !row.callSid) row.callSid = safeStr(callSid);
  if (streamSid && !row.streamSid) row.streamSid = safeStr(streamSid);
  return row;
}

function mark(callSid, streamSid, name, meta) {
  const row = ensure(callSid, streamSid);
  if (!row || !name) return null;
  if (!row.marks[name]) row.marks[name] = nowMs();
  if (meta && typeof meta === "object") {
    row.meta = { ...row.meta, ...meta };
  }
  return row;
}

function setMeta(callSid, streamSid, meta) {
  const row = ensure(callSid, streamSid);
  if (!row || !meta || typeof meta !== "object") return null;
  row.meta = { ...row.meta, ...meta };
  return row;
}

function getTiming(callSid, streamSid) {
  const key = getKey(callSid, streamSid);
  if (!key) return null;
  return STORE.get(key) || null;
}

function diff(row, fromName, toName) {
  if (!row) return null;
  const a = row.marks[fromName];
  const b = row.marks[toName];
  if (!a || !b) return null;
  return Math.max(0, b - a);
}

function consumeSummary(callSid, streamSid) {
  const row = getTiming(callSid, streamSid);
  if (!row) return null;
  return {
    callSid: row.callSid,
    streamSid: row.streamSid,
    createdAt: row.createdAt,
    meta: { ...row.meta },
    marks: { ...row.marks },
    metrics: {
      twiml_to_ws_start_ms: diff(row, "voice_twiml_requested", "twilio_stream_start"),
      ws_start_to_gemini_open_ms: diff(row, "twilio_stream_start", "gemini_ws_open"),
      gemini_open_to_opening_sent_ms: diff(row, "gemini_ws_open", "opening_sent"),
      ws_start_to_opening_sent_ms: diff(row, "twilio_stream_start", "opening_sent"),
      opening_sent_to_first_user_ms: diff(row, "opening_sent", "first_user_utterance"),
      opening_sent_to_first_bot_ms: diff(row, "opening_sent", "first_bot_utterance"),
      ws_start_to_first_bot_ms: diff(row, "twilio_stream_start", "first_bot_utterance"),
      total_call_ms: diff(row, "twilio_stream_start", "call_closed"),
    },
  };
}

function cleanup() {
  const cutoff = nowMs() - TTL_MS;
  for (const [key, row] of STORE.entries()) {
    if ((row?.createdAt || 0) < cutoff) STORE.delete(key);
  }
}

setInterval(cleanup, 5 * 60 * 1000).unref();

module.exports = {
  mark,
  setMeta,
  getTiming,
  consumeSummary,
};
