"use strict";

const express = require("express");
const { logger } = require("../utils/logger");
const { markCallEnded } = require("../outbound/stateStore");

const twilioStatusRouter = express.Router();

function handleTwilioStatus(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const meta = {
      callSid: body.CallSid || body.callSid || null,
      callStatus: body.CallStatus || body.callStatus || null,
      from: body.From || body.from || null,
      to: body.To || body.to || null,
      apiVersion: body.ApiVersion || body.apiVersion || null,
    };
    logger.info("Twilio status webhook", meta);
    const s = String(meta.callStatus || "").toLowerCase();
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(s)) {
      markCallEnded();
    }
  } catch (e) {
    logger.warn("Twilio status webhook parse error", { err: String(e?.message || e) });
  }
  res.status(200).type("text/plain").send("ok");
}

twilioStatusRouter.post("/twilio/status", handleTwilioStatus);
twilioStatusRouter.get("/twilio/status", handleTwilioStatus);

module.exports = { twilioStatusRouter };
