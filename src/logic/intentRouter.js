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

  const anyInterested =
    /(רלוונטי|יכול להתאים|יכול להיות לי|נשמע טוב|מעוניי?ן|חיובי|כן|סבבה|אוקיי|אוקי|ברור)/u.test(nv) ||
    /יכוללהתאים|נשמעטוב|רלוונטי/.test(compact);
  const asksHow =
    /(מה אתם יכולים|איך זה עובד|תסבירי|תסביר|ספרי לי|תספרי לי|ספר לי|מה זה נותן|מה זה כולל|על המערכת|על השירות|מה אתם מציעים|מה את מציעה)/u.test(nv) ||
    /איךזהעובד|מהאתםמציעים|מהאתמציעה|ספריליקצת|תספריליקצת/.test(compact);
  const asksWho =
    /(מי אתם|מי את|מה אתם|מה את|מיסטר בוט מי אתם)/u.test(nv) ||
    /מיאת|מיאתם|מהאתם|מהאת/.test(compact);
  const asksSource =
    /(איך הגעת אליי|איך הגעתם אליי|מאיפה הגעת אליי|מאיפה הגעתם אליי|מאיפה יש לך את הטלפון שלי|מאיפה יש לכם את המספר שלי|איפה מצאתם את המספר שלי)/u.test(nv) ||
    /איךהגעתאליי|איךהגעתםאליי|מאיפהישלךאתהטלפוןשלי|מאיפהישלכםאתהמספרשלי|איפהמצאתםאתהמספרשלי/.test(compact);
  const slowDown =
    /(דברי לאט|תדברי לאט|לא הבנתי|לא שמעתי|מהר מדי|רגע שנייה|שנייה רגע|תסבירי יותר לאט)/u.test(nv) ||
    /לאהבנתי|מהרמדי|דברילאט|תסבירילאט|רגעשנייה/.test(compact);
  const pain =
    /(לא מצליח לענות|לא עונה לכל השיחות|מפספס שיחות|עמוס|קובע תורים|לידים|מענה טלפוני|מזכירה|שירות לקוחות|מכירות|לא רוצה לפספס|לא תפספס|קשה לענות)/u.test(nv) ||
    /מפספסשיחות|לאמצליחלענות|שירותלקוחות|קובעתורים|תופסלידים|לארוצהלפספס/.test(compact);
  const business =
    /(מסעדה|חנות|חנות פרחים|קליניקה|מרפאה|מרפאת שיניים|משרד|עסק|סוכנות|מספרה|סטודיו|עורך דין|עו״ד|רואה חשבון|רופא שיניים)/u.test(nv) ||
    /מרפאתשיניים|חנותפרחים/.test(compact);
  const callback = /(תחזרו|שיחזרו|יחזרו אליי|חוזר אליי|תחזרי אליי|חזרה מחר|נדבר מחר|נדבר אחר כך)/u.test(nv);
  const notInterested = /(לא רלוונטי|לא מעוניי?ן|עזוב|לא צריך|לא רוצה|אין צורך)/u.test(nv);
  const existingSolution = /(יש לי כבר|כבר יש לי|כבר יש לנו|כבר מטפלים בזה|כבר יש מוקד|כבר יש מזכירה)/u.test(nv);

  if (/outbound_who_are_you/.test(id) && asksWho) {
    candidate.score += 18;
    candidate.matched_triggers.push("OUTBOUND_WHO");
  }
  if (/outbound_how_did_you_get_to_me/.test(id) && asksSource) {
    candidate.score += 18;
    candidate.matched_triggers.push("OUTBOUND_SOURCE");
  }
  if (/(outbound_slow_down|outbound_not_understood)/.test(id) && slowDown) {
    candidate.score += 18;
    candidate.matched_triggers.push("OUTBOUND_SLOW");
  }
  if (/(interested|relevant|qualified|positive)/.test(id) && anyInterested) {
    candidate.score += 12;
    candidate.matched_triggers.push("OUTBOUND_POSITIVE");
  }
  if (/(ask_how_it_works|what_do_you_offer|general_info|info)/.test(id) && asksHow) {
    candidate.score += 14;
    candidate.matched_triggers.push("OUTBOUND_EXPLAIN");
  }
  if (/(business_context|need|pain|qualification|capture)/.test(id) && (pain || business)) {
    candidate.score += 12;
    candidate.matched_triggers.push("OUTBOUND_NEED");
  }
  if (/callback/.test(id) && callback) {
    candidate.score += 14;
    candidate.matched_triggers.push("OUTBOUND_CALLBACK");
  }
  if (/existing_solution/.test(id) && existingSolution) {
    candidate.score += 14;
    candidate.matched_triggers.push("OUTBOUND_EXISTING");
  }
  if (/(not_relevant|not_interested)/.test(id) && notInterested) {
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

    if (/(מי אתם|מי את|מה אתם|מה את)/u.test(nv) || /מיאתם|מיאת|מהאתם|מהאת/.test(compact)) {
      return { intent_id: 'outbound_who_are_you', intent_type: 'outbound', score: 48, priority: 220, matched_triggers: ['WHO_ARE_YOU'] };
    }
    if (/(איך הגעת אליי|איך הגעתם אליי|מאיפה הגעת אליי|מאיפה הגעתם אליי|מאיפה יש לך את הטלפון שלי|מאיפה יש לכם את המספר שלי|איפה מצאתם את המספר שלי)/u.test(nv) || /איךהגעתאליי|איךהגעתםאליי|מאיפהישלךאתהטלפוןשלי|מאיפהישלכםאתהמספרשלי|איפהמצאתםאתהמספרשלי/.test(compact)) {
      return { intent_id: 'outbound_how_did_you_get_to_me', intent_type: 'outbound', score: 48, priority: 220, matched_triggers: ['HOW_REACHED_ME'] };
    }
    if (/(דברי לאט|תדברי לאט|לא הבנתי|לא שמעתי|מהר מדי|רגע שנייה|שנייה רגע|תסבירי יותר לאט)/u.test(nv) || /לאהבנתי|מהרמדי|דברילאט|תסבירילאט|רגעשנייה/.test(compact)) {
      return { intent_id: 'outbound_slow_down', intent_type: 'outbound', score: 46, priority: 215, matched_triggers: ['SLOW_DOWN'] };
    }
    if (/(מה אתם מציעים|מה את מציעה|מה אתם יכולים|מה השירות|מה זה נותן|מה זה כולל|איך זה עובד|ספרי לי|תספרי לי|ספר לי|תסבירי לי)/u.test(nv) || /מהאתםמציעים|מהאתמציעה|מהאתםיכולים|מהזהנותן|מהזהכולל|איךזהעובד|ספריליקצת|תספריליקצת|תסבירילימה/.test(compact)) {
      return { intent_id: 'outbound_what_do_you_offer', intent_type: 'outbound', score: 44, priority: 210, matched_triggers: ['WHAT_OFFER'] };
    }
    if (/(לא רלוונטי|לא מעוניי?ן|לא צריך|לא רוצה|אין צורך)/u.test(nv) || /לארלוונטי|לאמעוניין|לאצריך|לארוצה/.test(compact)) {
      return { intent_id: 'outbound_not_interested', intent_type: 'objection', score: 40, priority: 205, matched_triggers: ['NOT_INTERESTED'] };
    }
    if (/(יש לי כבר|כבר יש לי|כבר יש לנו|כבר מטפלים בזה|כבר יש מוקד|כבר יש מזכירה)/u.test(nv) || /כברישלי|כברישלנו|כברישמוקד|כברישמזכירה/.test(compact)) {
      return { intent_id: 'outbound_already_has_solution', intent_type: 'objection', score: 40, priority: 205, matched_triggers: ['ALREADY_HAVE'] };
    }
    if (/(תחזרו|שיחזרו|יחזרו אליי|חוזר אליי|תחזרי אליי|נדבר מחר|חזרה מחר|חזרה אחר כך)/u.test(nv) || /תחזרואליי|שיחזרו|יחזוראליי|נדברמחר/.test(compact)) {
      return { intent_id: 'outbound_callback_later', intent_type: 'callback', score: 40, priority: 205, matched_triggers: ['CALLBACK'] };
    }
    if (/(מסעדה|חנות|חנות פרחים|קליניקה|מרפאה|מרפאת שיניים|משרד|עסק|סוכנות|מספרה|סטודיו|עורך דין|רואה חשבון)/u.test(nv) || /מרפאתשיניים|חנותפרחים/.test(compact)) {
      return { intent_id: 'outbound_business_context', intent_type: 'qualification', score: 36, priority: 200, matched_triggers: ['BUSINESS_CONTEXT'] };
    }
    if (/(כן|רלוונטי|יכול להתאים|נשמע טוב|חיובי|מעניין|בכיף|סבבה)/u.test(nv) || /יכוללהתאים|נשמעטוב|רלוונטי/.test(compact)) {
      return { intent_id: 'outbound_interested', intent_type: 'qualification', score: 34, priority: 195, matched_triggers: ['INTERESTED'] };
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
