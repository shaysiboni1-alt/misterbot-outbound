"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { runOnce } = require("./outboundEngine");
const { setSchedulerEnabled, getState, markDialStarted } = require("./stateStore");

let timer = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const res = await runOnce();
    if (res?.ok) markDialStarted();
  } catch (e) {
    logger.warn("Outbound scheduler tick failed", { err: String(e?.message || e) });
  } finally {
    busy = false;
  }
}

function startScheduler() {
  if (timer) return getState();
  setSchedulerEnabled(true);
  timer = setInterval(tick, Math.max(15000, env.OUTBOUND_MIN_GAP_SECONDS * 1000));
  logger.info("Outbound scheduler started", { interval_ms: Math.max(15000, env.OUTBOUND_MIN_GAP_SECONDS * 1000) });
  return getState();
}

function stopScheduler() {
  setSchedulerEnabled(false);
  if (timer) clearInterval(timer);
  timer = null;
  logger.info("Outbound scheduler stopped");
  return getState();
}

module.exports = { startScheduler, stopScheduler, tick };
