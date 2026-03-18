"use strict";

const { env } = require("../config/env");
const { getState } = require("./stateStore");
const { getCallableLeads, markLeadDialing } = require("./leadSource");
const { createOutboundCall } = require("./twilioDialer");
const { logger } = require("../utils/logger");
const { isWithinAllowedWindow } = require("./scheduleGuard");
const { getSettingInt } = require("../ssot/ssotClient");

function canDialNow() {
  const state = getState();
  if (!env.OUTBOUND_ENABLED) return { ok: false, reason: "outbound_disabled" };
  const windowCheck = isWithinAllowedWindow();
  if (!windowCheck.ok) return { ok: false, reason: windowCheck.reason, meta: windowCheck.meta };

  const maxActiveCalls = getSettingInt("OUTBOUND_MAX_ACTIVE_CALLS", env.OUTBOUND_MAX_ACTIVE_CALLS);
  const maxCallsPerHour = getSettingInt("OUTBOUND_MAX_CALLS_PER_HOUR", env.OUTBOUND_MAX_CALLS_PER_HOUR);
  const minGapSeconds = getSettingInt("OUTBOUND_MIN_GAP_SECONDS", env.OUTBOUND_MIN_GAP_SECONDS);

  if (state.activeCalls >= maxActiveCalls) return { ok: false, reason: "active_limit", meta: { maxActiveCalls } };
  if (state.callsLastHour >= maxCallsPerHour) return { ok: false, reason: "hourly_limit", meta: { maxCallsPerHour } };
  if (state.lastDialAt && Date.now() - state.lastDialAt < minGapSeconds * 1000) {
    return { ok: false, reason: "min_gap", meta: { minGapSeconds } };
  }
  if (!env.TWILIO_FROM_NUMBER) return { ok: false, reason: "missing_from_number" };
  return { ok: true, meta: { maxActiveCalls, maxCallsPerHour, minGapSeconds } };
}

async function runOnce() {
  const gate = canDialNow();
  if (!gate.ok) return { ok: false, gate };
  const batchSize = getSettingInt("OUTBOUND_BATCH_SIZE", env.OUTBOUND_BATCH_SIZE || 1) || 1;
  const leads = await getCallableLeads(batchSize);
  if (!leads.length) return { ok: false, reason: "no_callable_leads" };
  const lead = leads[0];
  await markLeadDialing(lead);
  const call = await createOutboundCall({ to: lead.phone, lead });
  logger.info("Outbound call created", { lead_id: lead.lead_id, callSid: call?.sid, to: lead.phone });
  return { ok: true, lead, call };
}

module.exports = { runOnce, canDialNow };
