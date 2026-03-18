"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { runOnce } = require("./outboundEngine");
const { setSchedulerEnabled, getState, markDialStarted } = require("./stateStore");
const { getSettingInt, getSettingBool } = require("../ssot/ssotClient");

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

function getIntervalMs() {
  const minGapSeconds = getSettingInt("OUTBOUND_MIN_GAP_SECONDS", env.OUTBOUND_MIN_GAP_SECONDS);
  return Math.max(15000, minGapSeconds * 1000);
}

function shouldAutoStart() {
  return !!env.OUTBOUND_ENABLED && getSettingBool("OUTBOUND_AUTO_START", env.OUTBOUND_AUTO_START);
}

function startScheduler(options = {}) {
  if (timer) return getState();
  const intervalMs = getIntervalMs();
  setSchedulerEnabled(true);
  timer = setInterval(tick, intervalMs);
  logger.info("Outbound scheduler started", { interval_ms: intervalMs, auto_start: !!options.autoStart });
  if (options.runImmediately) {
    setTimeout(() => { tick().catch(() => {}); }, 250);
  }
  return getState();
}

function stopScheduler() {
  setSchedulerEnabled(false);
  if (timer) clearInterval(timer);
  timer = null;
  logger.info("Outbound scheduler stopped");
  return getState();
}

module.exports = { startScheduler, stopScheduler, tick, shouldAutoStart };
