"use strict";

const CACHE = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function nowMs() {
  return Date.now();
}

function applyTemplate(tpl, vars) {
  return safeStr(tpl).replace(/\{([A-Za-z0-9_]+)\}/g, (_, rawKey) => {
    const key = String(rawKey || "");
    return (
      vars?.[key] ??
      vars?.[key.toUpperCase()] ??
      vars?.[key.toLowerCase()] ??
      ""
    );
  });
}

function computeGreetingHebrew(timeZone) {
  const tz = timeZone || "Asia/Jerusalem";
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(new Date())
  );

  if (Number.isNaN(hour)) return "שלום";
  if (hour >= 5 && hour < 11) return "בוקר טוב";
  if (hour >= 11 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

function cleanOpeningText(text) {
  let t = safeStr(text);

  t = t.replace(/\s{2,}/g, " ").trim();

  // ניקוי פסיקים/רווחים כפולים אחרי מחיקת placeholders
  t = t.replace(/\s+,/g, ",");
  t = t.replace(/,\s*,/g, ",");
  t = t.replace(/\(\s*\)/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();

  // אם אין lead name, להסיר פנייה שבורה כמו "היי ,"
  t = t.replace(/^היי\s*,\s*/u, "היי ");
  t = t.replace(/^שלום\s*,\s*/u, "שלום ");
  t = t.replace(/^הלו\s*,\s*/u, "הלו ");

  t = t.replace(/\s+\?/g, "?");
  t = t.replace(/\s+\./g, ".");
  t = t.replace(/\s+!/g, "!");
  t = t.replace(/\s+,/g, ",");

  return t.trim();
}

function buildOpeningKey({
  settings,
  callerName,
  contactName,
  isReturning,
  greeting,
  callType,
  businessName,
}) {
  return JSON.stringify({
    callType: safeStr(callType),
    greeting: safeStr(greeting),
    callerName: safeStr(callerName),
    contactName: safeStr(contactName),
    isReturning: !!isReturning,
    businessName: safeStr(businessName || settings?.BUSINESS_NAME),
    botName: safeStr(settings?.BOT_NAME),
    outboundAgentName: safeStr(settings?.OUTBOUND_AGENT_NAME),
    outboundOpeningTemplate: safeStr(settings?.OUTBOUND_OPENING_TEMPLATE),
    outboundOpeningScript: safeStr(settings?.OUTBOUND_OPENING_SCRIPT),
    outboundOpeningReturning: safeStr(settings?.OUTBOUND_OPENING_SCRIPT_RETURNING),
    inboundOpeningTemplate: safeStr(settings?.INBOUND_OPENING_TEMPLATE),
    inboundOpeningScript: safeStr(settings?.OPENING_SCRIPT),
    inboundOpeningReturning: safeStr(settings?.OPENING_SCRIPT_RETURNING),
  });
}

function buildOutboundOpening(ssot, vars) {
  const settings = ssot?.settings || {};

  const greeting = safeStr(vars?.GREETING);
  const leadName =
    safeStr(vars?.LEAD_NAME) ||
    safeStr(vars?.CONTACT_NAME) ||
    safeStr(vars?.CALLER_NAME);

  const agentName =
    safeStr(vars?.AGENT_NAME) ||
    safeStr(settings.OUTBOUND_AGENT_NAME) ||
    "נועה";

  const businessName =
    safeStr(vars?.BUSINESS_NAME) ||
    safeStr(settings.BUSINESS_NAME) ||
    "Mr.Bot";

  let tpl =
    safeStr(settings.OUTBOUND_OPENING_TEMPLATE) ||
    safeStr(settings.OUTBOUND_OPENING_SCRIPT);

  if (!tpl) {
    tpl = "היי {lead_name}, {agent_name} ממיסטר בוט. יש רגע?";
  }

  const merged = {
    GREETING: greeting,
    lead_name: leadName,
    LEAD_NAME: leadName,
    caller_name: leadName,
    CALLER_NAME: leadName,
    contact_name: leadName,
    CONTACT_NAME: leadName,
    agent_name: agentName,
    AGENT_NAME: agentName,
    business_name: businessName,
    BUSINESS_NAME: businessName,
    bot_name: safeStr(settings.BOT_NAME),
    BOT_NAME: safeStr(settings.BOT_NAME),
    brand_name: safeStr(settings.BRAND_NAME),
    BRAND_NAME: safeStr(settings.BRAND_NAME),
  };

  let opening = applyTemplate(tpl, merged);

  // אם הטמפלייט לא כולל agent name אבל כן יש agent, אפשר להוסיף מינימלית רק אם זה לא מוזכר
  if (
    agentName &&
    !opening.includes(agentName) &&
    /מיסטר בוט/u.test(opening)
  ) {
    opening = opening.replace(/מיסטר בוט/u, `${agentName} ממיסטר בוט`);
  }

  opening = cleanOpeningText(opening);

  if (!opening) {
    opening = leadName
      ? `היי ${leadName}, ${agentName} ממיסטר בוט. יש רגע?`
      : `${agentName} ממיסטר בוט. יש רגע?`;
  }

  return opening;
}

function buildInboundOpening(ssot, vars) {
  const settings = ssot?.settings || {};
  const greeting = safeStr(vars?.GREETING);

  let tpl =
    safeStr(settings.INBOUND_OPENING_TEMPLATE) ||
    safeStr(settings.OPENING_SCRIPT) ||
    "שלום, מדבר/ת ממיסטר בוט. איך אפשר לעזור?";

  const merged = {
    GREETING: greeting,
    BUSINESS_NAME: safeStr(vars?.BUSINESS_NAME || settings.BUSINESS_NAME),
    BOT_NAME: safeStr(settings.BOT_NAME),
    BRAND_NAME: safeStr(settings.BRAND_NAME),
  };

  const opening = cleanOpeningText(applyTemplate(tpl, merged));
  return opening || "שלום, מדבר/ת ממיסטר בוט. איך אפשר לעזור?";
}

function getOpeningScriptFromSSOT(ssot, vars) {
  const callType = safeStr(vars?.CALL_TYPE || vars?.call_type || "inbound").toLowerCase();

  if (callType === "outbound") {
    return buildOutboundOpening(ssot, vars);
  }

  return buildInboundOpening(ssot, vars);
}

function getCachedOpening({
  ssot,
  callerName,
  contactName,
  isReturning,
  timeZone,
  ttlMs = DEFAULT_TTL_MS,
  callType = "inbound",
  businessName = "",
}) {
  const greeting = computeGreetingHebrew(timeZone);

  const key = buildOpeningKey({
    settings: ssot?.settings,
    callerName,
    contactName,
    isReturning,
    greeting,
    callType,
    businessName,
  });

  const cached = CACHE.get(key);
  const now = nowMs();

  if (cached && cached.expiresAt > now) {
    return { ...cached.value, cache_hit: true };
  }

  const opening = getOpeningScriptFromSSOT(ssot, {
    GREETING: greeting,
    CALLER_NAME: safeStr(callerName),
    CONTACT_NAME: safeStr(contactName || callerName),
    LEAD_NAME: safeStr(contactName || callerName),
    BUSINESS_NAME: safeStr(businessName),
    RETURNING_CALLER: !!isReturning,
    CALL_TYPE: callType,
  });

  const value = {
    opening,
    greeting,
    cache_hit: false,
  };

  CACHE.set(key, {
    value,
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
  });

  return value;
}

module.exports = {
  computeGreetingHebrew,
  getOpeningScriptFromSSOT,
  getCachedOpening,
};
