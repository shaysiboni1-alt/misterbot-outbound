"use strict";

const express = require("express");
const { env } = require("../config/env");
const { getState, markDialStarted } = require("../outbound/stateStore");
const { runOnce, canDialNow } = require("../outbound/outboundEngine");
const { startScheduler, stopScheduler, tick } = require("../outbound/outboundScheduler");
const { createOutboundCall } = require("../outbound/twilioDialer");
const { markLeadDialing } = require("../outbound/leadSource");

const router = express.Router();

function isAuthorized(req) {
  const supplied = String(req.headers["x-admin-token"] || "").trim();
  return !!env.OUTBOUND_ADMIN_TOKEN && supplied === String(env.OUTBOUND_ADMIN_TOKEN).trim();
}

router.use("/admin/outbound", (req, res, next) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
});

router.get("/admin/outbound/status", (req, res) => res.json({ ok: true, state: getState(), gate: canDialNow() }));
router.post("/admin/outbound/start", (req, res) => {
  const runImmediately = String(req.body?.run_immediately || "false").toLowerCase() === "true";
  return res.json({ ok: true, state: startScheduler({ runImmediately, autoStart: false }), gate: canDialNow() });
});
router.post("/admin/outbound/stop", (req, res) => res.json({ ok: true, state: stopScheduler() }));
router.post("/admin/outbound/run-once", async (req, res) => {
  const out = await runOnce();
  if (out?.ok) markDialStarted();
  res.json(out);
});
router.post("/admin/outbound/dial-lead", async (req, res) => {
  const lead = req.body || {};
  if (!lead.lead_id || !lead.phone) return res.status(400).json({ ok: false, error: "lead_id_and_phone_required" });
  await markLeadDialing(lead);
  const call = await createOutboundCall({ to: lead.phone, lead });
  markDialStarted();
  res.json({ ok: true, callSid: call?.sid || null, lead_id: lead.lead_id });
});

module.exports = { outboundAdminRouter: router };
