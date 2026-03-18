"use strict";

const { env } = require("../config/env");
const { getState } = require("./stateStore");
const { getCallableLeads, markLeadDialing } = require("./leadSource");
const { createOutboundCall } = require("./twilioDialer");
const { logger } = require("../utils/logger");

function canDialNow() {
  const state = getState();
  if (!env.OUTBOUND_ENABLED) return { ok: false, reason: "outbound_disabled" };
  if (state.activeCalls >= env.OUTBOUND_MAX_ACTIVE_CALLS) return { ok: false, reason: "active_limit" };
  if (state.callsLastHour >= env.OUTBOUND_MAX_CALLS_PER_HOUR) return { ok: false, reason: "hourly_limit" };
  if (state.lastDialAt && Date.now() - state.lastDialAt < env.OUTBOUND_MIN_GAP_SECONDS * 1000) {
    return { ok: false, reason: "min_gap" };
  }
  if (!env.TWILIO_FROM_NUMBER) return { ok: false, reason: "missing_from_number" };
  return { ok: true };
}

async function runOnce() {
  const gate = canDialNow();
  if (!gate.ok) return { ok: false, gate };
  const leads = await getCallableLeads(env.OUTBOUND_BATCH_SIZE || 1);
  if (!leads.length) return { ok: false, reason: "no_callable_leads" };
  const lead = leads[0];
  await markLeadDialing(lead);
  const call = await createOutboundCall({ to: lead.phone, lead });
  logger.info("Outbound call created", { lead_id: lead.lead_id, callSid: call?.sid, to: lead.phone });
  return { ok: true, lead, call };
}

module.exports = { runOnce, canDialNow };
