"use strict";

const express = require("express");
const { env } = require("../config/env");
const { getSetting, getSettingBool } = require("../ssot/ssotClient");

const router = express.Router();

router.get("/health", (req, res) => {
  return res.status(200).json({
    status: "ok",
    service: "Mr.Bot Voice Runtime",
    provider_mode: env.PROVIDER_MODE,
    outbound_enabled: env.OUTBOUND_ENABLED,
    outbound_auto_start: getSettingBool("OUTBOUND_AUTO_START", env.OUTBOUND_AUTO_START),
    outbound_allowed_days: getSetting("OUTBOUND_ALLOWED_DAYS", env.OUTBOUND_ALLOWED_DAYS),
    outbound_allowed_hours: getSetting("OUTBOUND_ALLOWED_HOURS", env.OUTBOUND_ALLOWED_HOURS),
    time: new Date().toISOString()
  });
});

module.exports = { healthRouter: router };
