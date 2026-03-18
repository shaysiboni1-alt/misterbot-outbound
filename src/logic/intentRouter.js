"use strict";

const { logger } = require("../utils/logger");
const { normalizeUtterance } = require("./hebrewNlp");

function splitTriggersCell(value) {
  return String(value || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function buildVariants(text) {
  const base = normalizeUtterance(text || "");
  const variants = unique([
    base.raw,
    base.normalized,
    base.normalized_for_numbers,
    String(base.normalized || "").replace(/\s+/g, ""),
  ]).map((s) => String(s || "").trim());

  return {
    lang: base.lang,
    normalized: base.normalized,
    variants: variants.filter(Boolean),
  };
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTokenMatch(text, token) {
  const body = escapeRegExp(token).replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${body}([^\\p{L}\\p{N}]|$)`, "iu");
  return re.test(text);
}

function scoreTriggerAgainstVariants(trigger, variants) {
  const t = normalizeUtterance(trigger || "").normalized;
  if (!t) return { score: 0, matched: null };

  const compactTrigger = t.replace(/\s+/g, "");
  const requiresBoundary = !/\s/.test(t) && compactTrigger.length >= 3;

  for (const v of variants) {
    const nv = normalizeUtterance(v).normalized;
    const compact = nv.replace(/\s+/g, "");

    if (requiresBoundary && hasTokenMatch(nv, t)) {
      return { score: t.length >= 5 ? 9 : 7, matched: trigger };
    }

    if (!requiresBoundary && nv.includes(t)) {
      return { score: t.length >= 5 ? 8 : 6, matched: trigger };
    }

    if (compact.includes(compactTrigger) && compactTrigger.length >= 4) {
      return { score: 5, matched: trigger };
    }
  }

  return { score: 0, matched: null };
}

function isOutboundIntent(it) {
  const id = String(it?.intent_id || "").trim().toLowerCase();
  const typ = String(it?.intent_type || "").trim().toLowerCase();
  return (
    id.startsWith("outbound_") ||
    ["sales", "outbound", "qualification", "objection", "callback", "lead"].includes(typ)
  );
}

function filterIntentsByCallType(intents, callType) {
  const mode = String(callType || "").trim().toLowerCase();
  if (mode !== "outbound") return intents;
  const outboundOnly = (intents || []).filter(isOutboundIntent);
  return outboundOnly.length ? outboundOnly : intents;
}

function applyOutboundHeuristics(prepared, candidate) {
  const nv = prepared.normalized || "";
  const compact = nv.replace(/\s+/g, "");
  const id = String(candidate.intent_id || "");

  const anyInterested = /(רלוונטי|יכול להתאים|יכול להיות לי|נשמע טוב|מעוניי?ן|חיובי|כן)/u.test(nv) || compact.includes("יכוללהתאים");
  const asksHow = /(מה אתם יכולים|איך זה עובד|תגיד.*קצת|ספר.*קצת|מה זה נותן|מה זה כולל|על המערכת|על השירות)/u.test(nv);
  const pain = /(לא מצליח לענות|לא עונה לכל השיחות|מפספס שיחות|עמוס|קובע תורים|לידים|מענה טלפוני|מזכירה|חנות|חנות פרחים)/u.test(nv) || compact.includes("מפספסשיחות");
  const callback = /(תחזרו|שיחזרו|יחזרו אלי|חוזר עליי|חזרו אליי)/u.test(nv);
  const notRelevant = /(לא רלוונטי|לא מעוניי?ן|עזוב|לא צריך|יש לי כבר)/u.test(nv);

  if (/interested|relevant|qualified|positive/.test(id) && anyInterested) {
    candidate.score += 12;
    candidate.matched_triggers.push("OUTBOUND_POSITIVE");
  }
  if (/ask_how_it_works|how_it_works|general_info|info/.test(id) && asksHow) {
    candidate.score += 12;
    candidate.matched_triggers.push("OUTBOUND_EXPLAIN");
  }
  if (/need|pain|qualification|capture/.test(id) && pain) {
    candidate.score += 10;
    candidate.matched_triggers.push("OUTBOUND_NEED");
  }
  if (/callback/.test(id) && callback) {
    candidate.score += 14;
    candidate.matched_triggers.push("OUTBOUND_CALLBACK");
  }
  if (/not_relevant|not_interested|existing_solution/.test(id) && notRelevant) {
    candidate.score += 14;
    candidate.matched_triggers.push("OUTBOUND_NEGATIVE");
  }
}

function emptyIntent() {
  return {
    intent_id: "other",
    intent_type: "other",
    score: 0,
    priority: 0,
    matched_triggers: [],
  };
}

function detectIntent(input, maybeIntents, maybeOpts = {}) {
  let textRaw = "";
  let intents = [];
  let opts = maybeOpts || {};

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    textRaw = String(input.text || "");
    intents = Array.isArray(input.intents) ? input.intents : [];
    opts = { ...input, text: undefined, intents: undefined };
  } else {
    textRaw = String(input || "");
    intents = Array.isArray(maybeIntents) ? maybeIntents : [];
  }

  intents = filterIntentsByCallType(intents, opts.callType);
  const prepared = buildVariants(textRaw);
  const lang = opts.forceLang || prepared.lang || "unknown";

  if (String(opts.callType || '').trim().toLowerCase() === 'outbound') {
    const nv = prepared.normalized || '';
    const compact = nv.replace(/\s+/g, '');
    if (/(איך הגעת אליי|איך הגעתם אליי|מאיפה הגעת|מאיפה הגעתם)/u.test(nv) || compact.includes('איךהגעתאליי') || compact.includes('איךהגעתםאליי')) {
      return { intent_id: 'outbound_how_did_you_get_to_me', intent_type: 'outbound', score: 40, priority: 200, matched_triggers: ['HOW_REACHED_ME'] };
    }
    if (/(מה את מציעה|מה אתם מציעים|מה אתם יכולים|מה השירות|מה זה נותן|איך זה עובד|ספרי לי|תגידי לי קצת)/u.test(nv) || compact.includes('מהאתמציעה') || compact.includes('מהאתםמציעים') || compact.includes('איךזהעובד')) {
      return { intent_id: 'outbound_what_do_you_offer', intent_type: 'outbound', score: 40, priority: 200, matched_triggers: ['WHAT_OFFER'] };
    }
    if (/(יש לי מסעדה|מסעדה|חנות|חנות פרחים|קליניקה|משרד|עסק)/u.test(nv)) {
      return { intent_id: 'outbound_business_context', intent_type: 'qualification', score: 32, priority: 180, matched_triggers: ['BUSINESS_CONTEXT'] };
    }
    if (/(כן|רלוונטי|יכול להתאים|נשמע טוב|חיובי|מעניין)/u.test(nv)) {
      return { intent_id: 'outbound_interested', intent_type: 'qualification', score: 30, priority: 170, matched_triggers: ['INTERESTED'] };
    }
  }

  if (!intents.length) return emptyIntent();

  let best = null;

  for (const it of intents) {
    const intentId = String(it?.intent_id || "").trim();
    const intentType = String(it?.intent_type || "").trim() || "other";
    const priority = Number(it?.priority ?? 0) || 0;
    if (!intentId) continue;

    const triggersCell =
      lang === "he"
        ? it?.triggers_he
        : lang === "ru"
          ? it?.triggers_ru
          : it?.triggers_en;

    const triggers = splitTriggersCell(triggersCell);
    if (!triggers.length) continue;

    let score = 0;
    const matched = [];

    for (const tr of triggers) {
      const res = scoreTriggerAgainstVariants(tr, prepared.variants);
      if (res.score > 0) {
        score += res.score;
        matched.push(res.matched);
      }
    }

    const nv = prepared.normalized;
    const compact = nv.replace(/\s+/g, "");

    if (
      intentId === "reports_request" &&
      (/דוחות|דוח|מסמכים|רווח והפסד/u.test(nv) || compact.includes("רווחוהפסד"))
    ) {
      score += 4;
      matched.push('דו"ח');
    }

    if (
      intentId === "reach_margarita" &&
      (/מרגריטה|ריטה/u.test(nv) || compact.includes("מרגריטה"))
    ) {
      score += 4;
      matched.push("מרגריטה");
    }

    if (
      intentId === "callback_request" &&
      (/לחזור|תחזור|יחזרו|שיחזרו/u.test(nv) || compact.includes("לחזור"))
    ) {
      score += 4;
      matched.push("לחזור");
    }

    if (score <= 0) continue;

    const candidate = {
      intent_id: intentId,
      intent_type: intentType,
      score,
      priority,
      matched_triggers: unique(matched).slice(0, 8),
    };

    if (String(opts.callType || "").trim().toLowerCase() === "outbound") {
      applyOutboundHeuristics(prepared, candidate);
      candidate.matched_triggers = unique(candidate.matched_triggers).slice(0, 8);
    }

    if (!best) {
      best = candidate;
      continue;
    }

    if (candidate.score > best.score) best = candidate;
    else if (candidate.score === best.score) {
      if (candidate.priority > best.priority) best = candidate;
      else if (candidate.priority === best.priority) {
        if (candidate.intent_id.localeCompare(best.intent_id) < 0) best = candidate;
      }
    }
  }

  if (!best) return emptyIntent();

  if (opts.logDebug) {
    logger.info("INTENT_DEBUG", {
      lang,
      normalized: prepared.normalized,
      variants: prepared.variants,
      best,
    });
  }

  return best;
}

module.exports = { detectIntent };
