"use strict";

const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function mapRows(header, rows) {
  return (rows || []).map((row) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = safeStr(row[i]);
    });
    return obj;
  });
}

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: SCOPES,
  });
  return auth.getClient();
}

async function fetchSheet(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = res.data.values || [];
  if (!values.length) return [];

  const [header, ...rows] = values;
  return mapRows(header, rows);
}

async function loadSSOT() {
  const spreadsheetId = process.env.GSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("Missing GSHEET_ID in env");
  }

  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // ⚡ כאן אנחנו טוענים את כל הגיליונות
  const [
    settings,
    prompts,
    intents,
    packages,
    outboundSettings,
    campaignSettings,
    dispositions,
    retryRules,
    scriptVariants,
    objectionTags,
    leadScoringRules,
    contactListSchema,
    outboundFlow, // 🔥 החדש
  ] = await Promise.all([
    fetchSheet(sheets, spreadsheetId, "SETTINGS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "PROMPTS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "INTENTS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "PACKAGES!A:Z"),
    fetchSheet(sheets, spreadsheetId, "OUTBOUND_SETTINGS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "CAMPAIGN_SETTINGS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "DISPOSITIONS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "RETRY_RULES!A:Z"),
    fetchSheet(sheets, spreadsheetId, "SCRIPT_VARIANTS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "OBJECTION_TAGS!A:Z"),
    fetchSheet(sheets, spreadsheetId, "LEAD_SCORING_RULES!A:Z"),
    fetchSheet(sheets, spreadsheetId, "CONTACT_LIST_SCHEMA!A:Z"),
    fetchSheet(sheets, spreadsheetId, "OUTBOUND_FLOW!A:Z"), // 🔥 קריטי
  ]);

  return {
    settings,
    prompts,
    intents,
    packages,
    outbound_settings: outboundSettings,
    campaign_settings: campaignSettings,
    dispositions,
    retry_rules: retryRules,
    script_variants: scriptVariants,
    objection_tags: objectionTags,
    lead_scoring_rules: leadScoringRules,
    contact_list_schema: contactListSchema,
    outbound_flow: outboundFlow, // 🔥 חיבור ל-state machine
  };
}

module.exports = {
  loadSSOT,
};
