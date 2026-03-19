"use strict";

const { google } = require("googleapis");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

let CACHE = {
  loaded_at: null,
  expires_at: 0,
  settings: {},
  prompts: {},
  intents: [],
  knowledge_base: {},
  packages: [],
  outbound_rules: {},
  outbound_script: [],
  routing_rules: [],
  outbound_leads: [],
  outbound_flow: [],
};

function stripOuterQuotes(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function b64ToJson(b64) {
  const raw = stripOuterQuotes(b64 || "");
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function isCacheValid() {
  return Date.now() < (CACHE.expires_at || 0) && CACHE.loaded_at;
}

async function getSheetsClient() {
  const sheetId = (env.GSHEET_ID || "").trim();
  if (!sheetId) throw new Error("Missing GSHEET_ID");

  const sa = b64ToJson(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64);
  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error("Missing/invalid GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, sheetId };
}

function dropHeader(values) {
  if (!Array.isArray(values) || !values.length) return [];
  return values.slice(1);
}

function rowsToKV(rows) {
  const out = {};
  for (const r of rows || []) {
    const k = String(r?.[0] ?? "").trim();
    if (!k) continue;
    out[k] = r?.[1] === undefined || r?.[1] === null ? "" : String(r[1]);
  }
  return out;
}

function rowsToPrompts(rows) {
  const out = {};
  for (const r of rows || []) {
    const id = String(r?.[0] ?? "").trim();
    if (!id) continue;
    out[id] = r?.[1] === undefined || r?.[1] === null ? "" : String(r[1]);
  }
  return out;
}

function rowsToIntents(rows) {
  return (rows || [])
    .map((r) => ({
      intent_id: String(r?.[0] ?? "").trim(),
      intent_type: String(r?.[1] ?? "").trim(),
      priority: Number(String(r?.[2] ?? "0").trim()) || 0,
      triggers_he: String(r?.[3] ?? ""),
      triggers_en: String(r?.[4] ?? ""),
      triggers_ru: String(r?.[5] ?? ""),
    }))
    .filter((x) => x.intent_id);
}

function rowsToNamedObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const header = values[0].map((x) => String(x || "").trim());
  const rows = values.slice(1);

  return rows
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => {
        if (!h) return;
        obj[h] = r?.[i] === undefined || r?.[i] === null ? "" : String(r[i]);
      });
      return obj;
    })
    .filter((obj) => Object.values(obj).some((v) => String(v || "").trim()));
}

async function batchGetRanges(ranges) {
  const { sheets, sheetId } = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
  });
  return resp?.data?.valueRanges || [];
}

async function loadSSOT(force = false) {
  const ttl = env.SSOT_TTL_MS || 60000;
  if (!force && isCacheValid()) return CACHE;

  const startedAt = Date.now();

  const ranges = [
    "SETTINGS!A:B",
    "PROMPTS!A:B",
    "INTENTS!A:F",
    "KNOWLEDGE_BASE!A:B",
    "PACKAGES!A:G",
    "OUTBOUND_RULES!A:C",
    "OUTBOUND_SCRIPT!A:C",
    "ROUTING_RULES!A:D",
    "OUTBOUND_LEADS!A:Z",
    "OUTBOUND_FLOW!A:Z",
  ];

  let vrs = [];
  try {
    vrs = await batchGetRanges(ranges);
  } catch (e) {
    if (!String(e?.message || e).includes("Unable to parse range")) throw e;
    vrs = await batchGetRanges([
      "SETTINGS!A:B",
      "PROMPTS!A:B",
      "INTENTS!A:F",
      "OUTBOUND_FLOW!A:Z",
    ]);
  }

  const settings = rowsToKV(dropHeader(vrs?.[0]?.values || []));
  const prompts = rowsToPrompts(dropHeader(vrs?.[1]?.values || []));
  const intents = rowsToIntents(dropHeader(vrs?.[2]?.values || []));
  const knowledge_base = rowsToKV(dropHeader(vrs?.[3]?.values || []));
  const packages = rowsToNamedObjects(vrs?.[4]?.values || []);
  const outbound_rules = rowsToKV(dropHeader(vrs?.[5]?.values || []));
  const outbound_script = rowsToNamedObjects(vrs?.[6]?.values || []);
  const routing_rules = rowsToNamedObjects(vrs?.[7]?.values || []);
  const outbound_leads = rowsToNamedObjects(vrs?.[8]?.values || []);
  const outbound_flow = rowsToNamedObjects(vrs?.[9]?.values || []);

  CACHE = {
    loaded_at: new Date().toISOString(),
    expires_at: Date.now() + ttl,
    settings,
    prompts,
    intents,
    knowledge_base,
    packages,
    outbound_rules,
    outbound_script,
    routing_rules,
    outbound_leads,
    outbound_flow,
  };

  logger.info("SSOT loaded", {
    settings_keys: Object.keys(settings).length,
    prompts_keys: Object.keys(prompts).length,
    intents: intents.length,
    outbound_leads: outbound_leads.length,
    outbound_flow: outbound_flow.length,
    ms: Date.now() - startedAt,
  });

  return CACHE;
}

function getSSOT() {
  return CACHE;
}

function getSetting(key, fallback = "") {
  const settings = CACHE?.settings || {};
  if (
    Object.prototype.hasOwnProperty.call(settings, key) &&
    String(settings[key] ?? "").trim() !== ""
  ) {
    return String(settings[key]);
  }
  return fallback;
}

function getSettingBool(key, fallback = false) {
  const raw = getSetting(
    key,
    fallback === undefined || fallback === null ? "" : String(fallback)
  );
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return !!fallback;
  return ["true", "1", "yes", "y", "on"].includes(normalized);
}

function getSettingInt(key, fallback = 0) {
  const raw = getSetting(key, String(fallback));
  const n = parseInt(String(raw || "").trim(), 10);
  return Number.isNaN(n) ? fallback : n;
}

async function appendSheetRow(sheetName, values) {
  const { sheets, sheetId } = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

async function updateLeadRowByLeadId(leadId, patch) {
  const leadIdStr = String(leadId || "").trim();
  if (!leadIdStr) return { ok: false, reason: "missing_lead_id" };

  const { sheets, sheetId } = await getSheetsClient();
  const getResp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "OUTBOUND_LEADS!A:Z",
  });

  const values = getResp?.data?.values || [];
  if (!values.length) return { ok: false, reason: "no_sheet" };

  const header = values[0].map((x) => String(x || "").trim());
  const leadIdIdx = header.indexOf("lead_id");
  if (leadIdIdx < 0) return { ok: false, reason: "missing_lead_id_column" };

  const rowIndex = values.findIndex(
    (r, idx) => idx > 0 && String(r?.[leadIdIdx] || "").trim() === leadIdStr
  );
  if (rowIndex < 1) return { ok: false, reason: "lead_not_found" };

  const currentRow = header.map((_, i) => values[rowIndex]?.[i] ?? "");
  for (const [k, v] of Object.entries(patch || {})) {
    const idx = header.indexOf(k);
    if (idx >= 0) currentRow[idx] = v === undefined || v === null ? "" : String(v);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `OUTBOUND_LEADS!A${rowIndex + 1}:Z${rowIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [currentRow] },
  });

  return { ok: true, rowIndex: rowIndex + 1 };
}

module.exports = {
  loadSSOT,
  getSSOT,
  getSetting,
  getSettingBool,
  getSettingInt,
  appendSheetRow,
  updateLeadRowByLeadId,
};
