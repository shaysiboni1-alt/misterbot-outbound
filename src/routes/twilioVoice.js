"use strict";

const express = require("express");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { mark } = require("../utils/callTiming");

const router = express.Router();

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

router.all("/twilio/outbound/voice", (req, res) => {
  const q = { ...req.query, ...req.body };
  const callSid = String(req.body?.CallSid || req.query?.CallSid || "").trim();
  const leadId = String(q.lead_id || "").trim();
  mark(callSid, null, "voice_twiml_requested", {
    route: "/twilio/outbound/voice",
    lead_id: leadId,
    contact_name: String(q.contact_name || "").trim(),
    business_name: String(q.business_name || "").trim(),
  });
  const streamUrl = `${env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio-media-stream`;
  const params = {
    caller: req.body?.To || req.query?.to || "",
    called: req.body?.From || req.query?.from || env.TWILIO_FROM_NUMBER || "",
    source: "Mr.Bot Outbound",
    call_type: "outbound",
    lead_id: q.lead_id || "",
    contact_name: q.contact_name || "",
    business_name: q.business_name || "",
    campaign_id: q.campaign_id || "",
  };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${esc(streamUrl)}">
      <Parameter name="caller" value="${esc(params.caller)}" />
      <Parameter name="called" value="${esc(params.called)}" />
      <Parameter name="source" value="${esc(params.source)}" />
      <Parameter name="call_type" value="${esc(params.call_type)}" />
      <Parameter name="lead_id" value="${esc(params.lead_id)}" />
      <Parameter name="contact_name" value="${esc(params.contact_name)}" />
      <Parameter name="business_name" value="${esc(params.business_name)}" />
      <Parameter name="campaign_id" value="${esc(params.campaign_id)}" />
    </Stream>
  </Connect>
  <Pause length="600"/>
</Response>`;

  logger.info("Twilio outbound voice TwiML served", {
    callSid: callSid || null,
    lead_id: leadId || null,
    contact_name: params.contact_name || null,
    business_name: params.business_name || null,
    stream_url_host: streamUrl.replace(/^wss?:\/\//, ""),
  });

  res.status(200).type("text/xml").send(xml);
});

module.exports = { twilioVoiceRouter: router };
