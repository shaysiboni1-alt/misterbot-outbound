"use strict";

const { env } = require("../config/env");
const { getSSOT } = require("../ssot/ssotClient");
const { preparePrewarmedOpening } = require("./firstTurnController");
const { setPrewarmCallSid, deletePrewarmEntry } = require("./prewarmStore");

function authHeader() {
  const token = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

function buildOutboundVoiceUrl(query) {
  const base = (env.TWILIO_OUTBOUND_VOICE_URL || `${env.PUBLIC_BASE_URL}/twilio/outbound/voice`).trim();
  const url = new URL(base);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim()) url.searchParams.set(k, String(v));
  });
  return url.toString();
}

async function createOutboundCall({ to, lead }) {
  const statusCallback = (env.TWILIO_STATUS_CALLBACK_URL || `${env.PUBLIC_BASE_URL}/twilio/status`).trim();
  const ssot = getSSOT();
  const prewarm = preparePrewarmedOpening({ lead, ssot, callType: "outbound" });

  const voiceUrl = buildOutboundVoiceUrl({
    lead_id: lead.lead_id,
    contact_name: lead.contact_name,
    business_name: lead.business_name,
    campaign_id: lead.campaign_id,
    prewarm_key: prewarm.prewarmKey,
  });

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", env.TWILIO_FROM_NUMBER);
  form.set("Url", voiceUrl);

  if (statusCallback) {
    form.set("StatusCallback", statusCallback);
    ["initiated", "ringing", "answered", "completed"].forEach((event) => {
      form.append("StatusCallbackEvent", event);
    });
    form.set("StatusCallbackMethod", "POST");
  }

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    deletePrewarmEntry(prewarm.prewarmKey);
    const msg = data?.message || text || `Twilio dial failed (${resp.status})`;
    throw new Error(msg);
  }

  if (data?.sid) setPrewarmCallSid(prewarm.prewarmKey, data.sid);
  return data;
}

module.exports = { createOutboundCall, buildOutboundVoiceUrl };
