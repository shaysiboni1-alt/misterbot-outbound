"use strict";

const { getSSOT, updateLeadRowByLeadId, appendSheetRow } = require("../ssot/ssotClient");

function toInt(v, def = 0) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isNaN(n) ? def : n;
}

function parseDateMs(v) {
  const t = Date.parse(String(v || "").trim());
  return Number.isFinite(t) ? t : 0;
}

function normalizeLead(raw) {
  return {
    lead_id: String(raw.lead_id || "").trim(),
    contact_name: String(raw.contact_name || raw.lead_name || "").trim(),
    business_name: String(raw.business_name || "").trim(),
    phone: String(raw.phone || "").trim(),
    status: String(raw.status || "new").trim().toLowerCase(),
    attempt_count: toInt(raw.attempt_count, 0),
    next_call_at: String(raw.next_call_at || "").trim(),
    source: String(raw.source || "").trim(),
    notes: String(raw.notes || "").trim(),
    campaign_id: String(raw.campaign_id || "default").trim(),
  };
}

function isCallableStatus(status) {
  return ["", "new", "queued", "retry", "pending"].includes(String(status || "").trim().toLowerCase());
}

async function getCallableLeads(limit = 1) {
  const ssot = getSSOT();
  const now = Date.now();
  const leads = (ssot?.outbound_leads || [])
    .map(normalizeLead)
    .filter((lead) => lead.lead_id && lead.phone)
    .filter((lead) => isCallableStatus(lead.status))
    .filter((lead) => !lead.next_call_at || parseDateMs(lead.next_call_at) <= now)
    .sort((a, b) => parseDateMs(a.next_call_at) - parseDateMs(b.next_call_at) || a.attempt_count - b.attempt_count)
    .slice(0, Math.max(1, limit));
  return leads;
}

async function markLeadDialing(lead) {
  return updateLeadRowByLeadId(lead.lead_id, {
    status: "dialing",
    attempt_count: String((lead.attempt_count || 0) + 1),
    last_call_at: new Date().toISOString(),
  });
}

async function markLeadOutcome(leadId, patch) {
  return updateLeadRowByLeadId(leadId, patch);
}

async function appendCallResult(result) {
  return appendSheetRow("OUTBOUND_CALL_RESULTS", [
    result.call_id || "",
    result.lead_id || "",
    result.started_at || "",
    result.ended_at || "",
    result.call_outcome || "",
    result.qualified || "",
    result.objection_type || "",
    result.summary || "",
    result.followup_required || "",
    result.followup_date || "",
  ]);
}

module.exports = { getCallableLeads, markLeadDialing, markLeadOutcome, appendCallResult };
