"use strict";

const express = require("express");
const { loadSSOT } = require("../ssot/ssotClient");

const router = express.Router();

router.post("/admin/reload-sheets", async (req, res) => {
  try {
    const adminToken = String(req.headers["x-admin-token"] || "").trim();
    const expectedToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    if (!expectedToken || adminToken !== expectedToken) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const t0 = Date.now();
    const ssot = await loadSSOT(true);
    return res.json({
      ok: true,
      ms: Date.now() - t0,
      reloaded_at: new Date().toISOString(),
      settings_keys: Object.keys(ssot?.settings || {}).length,
      prompts_keys: Object.keys(ssot?.prompts || {}).length,
      intents: Array.isArray(ssot?.intents) ? ssot.intents.length : 0,
      outbound_leads: Array.isArray(ssot?.outbound_leads) ? ssot.outbound_leads.length : 0,
      outbound_rules: Object.keys(ssot?.outbound_rules || {}).length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = { adminReloadRouter: router };
