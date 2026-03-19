"use strict";

const express = require("express");
const { env } = require("../config/env");

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
    prewarm_key: q.prewarm_key || "",
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
      <Parameter name="prewarm_key" value="${esc(params.prewarm_key)}" />
    </Stream>
  </Connect>
  <Pause length="600"/>
</Response>`;

  res.status(200).type("text/xml").send(xml);
});

module.exports = { twilioVoiceRouter: router };
