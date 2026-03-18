"use strict";

const express = require("express");
const { env } = require("../config/env");

const router = express.Router();

router.get("/health", (req, res) => {
  return res.status(200).json({
    status: "ok",
    service: "Mr.Bot Voice Runtime",
    provider_mode: env.PROVIDER_MODE,
    outbound_enabled: env.OUTBOUND_ENABLED,
    time: new Date().toISOString()
  });
});

module.exports = { healthRouter: router };
