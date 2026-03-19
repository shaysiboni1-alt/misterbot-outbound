"use strict";

const CACHE = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}
function nowMs() { return Date.now(); }

function applyTemplate(tpl, vars) {
  return safeStr(tpl).replace(/\{([A-Za-z0-9_]+)\}/g, (_, rawKey) => {
    const key = String(rawKey || "");
    return vars?.[key] ?? vars?.[key.toUpperCase()] ?? vars?.[key.toLowerCase()] ?? "";
  });
}

function computeGreetingHebrew(timeZone) {
  const tz = timeZone || "Asia/Jerusalem";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()));
  if (Number.isNaN(hour)) return "שלום";
  if (hour >= 5 && hour < 11) return "בוקר טוב";
  if (hour >= 11 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

function buildOpeningKey({ settings, callerName, isReturning, greeting, callType, businessName }) {
  return JSON.stringify({
    callType: safeStr(callType),
    opening: safeStr(settings?.OPENING_SCRIPT),
    openingReturning: safeStr(settings?.OPENING_SCRIPT_RETURNING),
    outbound: safeStr(settings?.OUTBOUND_OPENING_SCRIPT),
    outboundReturning: safeStr(settings?.OUTBOUND_OPENING_SCRIPT_RETURNING),
    businessName: safeStr(businessName || settings?.BUSINESS_NAME),
    botName: safeStr(settings?.BOT_NAME),
    callerName: safeStr(callerName),
    isReturning: !!isReturning,
    greeting: safeStr(greeting),
  });
}

function getOpeningScriptFromSSOT(ssot, vars) {
  const settings = ssot?.settings || {};
  const callType = safeStr(vars?.CALL_TYPE || vars?.call_type || "inbound").toLowerCase();
  const isReturning = Boolean(vars?.RETURNING_CALLER) || Boolean(vars?.returning_caller);
  const businessName = safeStr(vars?.BUSINESS_NAME || settings.BUSINESS_NAME);
  const contactName = safeStr(vars?.CALLER_NAME || vars?.CONTACT_NAME);

  let tpl = "";
  if (callType === "outbound") {
    tpl = (isReturning && safeStr(settings.OUTBOUND_OPENING_SCRIPT_RETURNING)) || safeStr(settings.OUTBOUND_OPENING_SCRIPT);
    if (!tpl) {
      tpl = "{GREETING}, מדבר/ת ממיסטר בוט. אפשר רגע לדבר עם {CALLER_NAME} לגבי מענה טלפוני חכם לעסק?";
    }
  } else {
    tpl = (isReturning && safeStr(settings.OPENING_SCRIPT_RETURNING)) || safeStr(settings.OPENING_SCRIPT) || "שלום! איך נוכל לעזור?";
  }

  const merged = {
    BUSINESS_NAME: businessName,
    BOT_NAME: safeStr(settings.BOT_NAME),
    CALLER_NAME: contactName,
    CONTACT_NAME: contactName,
    BUSINESS_EMAIL: safeStr(settings.BUSINESS_EMAIL),
    WORKING_HOURS: safeStr(settings.WORKING_HOURS),
    BUSINESS_WEBSITE_URL: safeStr(settings.BUSINESS_WEBSITE_URL),
    GREETING: safeStr(vars?.GREETING),
    CALL_TYPE: callType,
    ...vars,
  };

  const filled = applyTemplate(tpl, merged).replace(/\s{2,}/g, " ").trim();
  return filled || "שלום! איך נוכל לעזור?";
}

function getCachedOpening({ ssot, callerName, isReturning, timeZone, ttlMs = DEFAULT_TTL_MS, callType = "inbound", businessName = "" }) {
  const greeting = computeGreetingHebrew(timeZone);
  const key = buildOpeningKey({ settings: ssot?.settings, callerName, isReturning, greeting, callType, businessName });
  const cached = CACHE.get(key);
  const now = nowMs();
  if (cached && cached.expiresAt > now) return { ...cached.value, cache_hit: true };

  const opening = getOpeningScriptFromSSOT(ssot, {
    GREETING: greeting,
    CALLER_NAME: safeStr(callerName),
    CONTACT_NAME: safeStr(callerName),
    BUSINESS_NAME: safeStr(businessName),
    RETURNING_CALLER: !!isReturning,
    CALL_TYPE: callType,
  });

  const value = { opening, greeting, cache_hit: false };
  CACHE.set(key, { value, expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS) });
  return value;
}

module.exports = { computeGreetingHebrew, getOpeningScriptFromSSOT, getCachedOpening };
