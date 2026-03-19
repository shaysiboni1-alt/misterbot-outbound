"use strict";

const STORE = new Map();
const DEFAULT_TTL_MS = 2 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function pruneExpired() {
  const now = nowMs();
  for (const [key, entry] of STORE.entries()) {
    if (!entry || (entry.expiresAt && entry.expiresAt <= now)) {
      try {
        entry?.dispose?.();
      } catch {}
      STORE.delete(key);
    }
  }
}

function createPrewarmEntry({ key, openingText, callType, meta, ttlMs = DEFAULT_TTL_MS, dispose = null }) {
  pruneExpired();
  const entry = {
    key,
    callSid: "",
    openingText: String(openingText || "").trim(),
    openingAudioChunks: [],
    callType: String(callType || "inbound").trim() || "inbound",
    meta: meta || {},
    ready: false,
    failed: false,
    attached: false,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    expiresAt: nowMs() + Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS),
    error: "",
    dispose: typeof dispose === "function" ? dispose : null,
  };
  STORE.set(key, entry);
  return entry;
}

function getPrewarmEntry(key) {
  pruneExpired();
  return STORE.get(String(key || "").trim()) || null;
}

function updatePrewarmEntry(key, patch) {
  const entry = getPrewarmEntry(key);
  if (!entry) return null;
  Object.assign(entry, patch || {});
  entry.updatedAt = nowMs();
  return entry;
}

function markPrewarmReady(key, openingAudioChunks) {
  return updatePrewarmEntry(key, {
    ready: true,
    failed: false,
    openingAudioChunks: Array.isArray(openingAudioChunks) ? openingAudioChunks.slice() : [],
  });
}

function markPrewarmFailed(key, error) {
  return updatePrewarmEntry(key, {
    ready: false,
    failed: true,
    error: String(error || "prewarm_failed"),
  });
}

function setPrewarmCallSid(key, callSid) {
  return updatePrewarmEntry(key, { callSid: String(callSid || "").trim() });
}

function markPrewarmAttached(key) {
  return updatePrewarmEntry(key, { attached: true });
}

function deletePrewarmEntry(key) {
  const entry = STORE.get(String(key || "").trim());
  if (!entry) return false;
  try {
    entry.dispose?.();
  } catch {}
  return STORE.delete(String(key || "").trim());
}

async function waitForPrewarmReady(key, timeoutMs = 1500, intervalMs = 25) {
  const started = nowMs();
  while (nowMs() - started < Math.max(0, Number(timeoutMs) || 0)) {
    const entry = getPrewarmEntry(key);
    if (!entry) return null;
    if (entry.ready || entry.failed) return entry;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return getPrewarmEntry(key);
}

module.exports = {
  createPrewarmEntry,
  getPrewarmEntry,
  updatePrewarmEntry,
  markPrewarmReady,
  markPrewarmFailed,
  setPrewarmCallSid,
  markPrewarmAttached,
  deletePrewarmEntry,
  waitForPrewarmReady,
};
