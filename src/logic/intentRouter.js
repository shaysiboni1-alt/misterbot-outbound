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
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function safeText(x) {
  return String(x || "").trim();
}

function buildVariants(text) {
  const base = normalizeUtterance(text || "");
  const variants = unique([
    base.raw,
    base.normalized,
    base.normalized_for_numbers,
    String(base.normalized || "").replace(/\s+/g, ""),
  ]).map((s) => safeText(s));

  return {
    lang: base.lang,
    raw: safeText(base.raw),
    normalized: safeText(base.normalized),
    variants: variants.filter(Boolean),
  };
}

function scoreTriggerAgainstVariants(trigger, variants) {
  const t = normalizeUtterance(trigger || "").normalized;
  if (!t) return { score: 0, matched: null };

  const compactTrigger = t.replace(/\s+/g, "");

  for (const v of variants) {
    const nv = normalizeUtterance(v).normalized;
    const compact = nv.replace(/\s+/g, "");

    if (nv.includes(t)) {
      return { score: t.length >= 5 ? 8 : 6, matched: trigger };
    }

    if (compact.includes(compactTrigger) && compactTrigger.length >= 3) {
      return { score: 6, matched: trigger };
    }
  }

  return { score: 0, matched: null };
}

function baseOtherIntent() {
  return {
    intent_id: "other_general",
    intent_type: "other",
    score: 0,
    priority: 0,
    matched_triggers: [],
  };
}

function negationHeuristic(normalized) {
  const t = safeText(normalized);

  if (!t) return null;

  if (
    /(לא\s*מעוניי?ן|לא\s*רלוונטי|לא\s*צריך|לא\s*בא לי|לא\s*רוצה|עזוב|עזבי|תוותר|תוותרי|תודה[, ]*ביי|ביי|יאללה\s*ביי)/u.test(
      t
    )
  ) {
    return {
      intent_id: "outbound_not_interested",
      intent_type: "outbound",
      score: 100,
      priority: 999,
      matched_triggers: ["negative_phrase"],
    };
  }

  if (
    /(לא\s*עכשיו|לא\s*זמן\s*טוב|עסוק|עמוס|דבר\s*אחר\s*כך|תחזור\s*אחר\s*כך|יותר\s*מאוחר|מחר)/u.test(
      t
    )
  ) {
    return {
      intent_id: "outbound_callback_later",
      intent_type: "outbound",
      score: 95,
      priority: 998,
      matched_triggers: ["callback_later_phrase"],
    };
  }

  if (
    /(יש\s*לנו\s*כבר|יש\s*מזכירה|יש\s*מוקד|אנחנו\s*מסודרים|כבר\s*יש\s*פתרון)/u.test(
      t
    )
  ) {
    return {
      intent_id: "outbound_already_has_solution",
      intent_type: "outbound",
      score: 95,
      priority: 997,
      matched_triggers: ["existing_solution_phrase"],
    };
  }

  if (
    /(אני\s*לא\s*מקבל\s*החלטות|לא\s*הבן\s*אדם\s*הנכון|לא\s*אני|דבר\s*עם\s*מנהל|תדבר\s*עם\s*מנהל|תדברי\s*עם\s*מנהל)/u.test(
      t
    )
  ) {
    return {
      intent_id: "outbound_gatekeeper",
      intent_type: "outbound",
      score: 95,
      priority: 996,
      matched_triggers: ["gatekeeper_phrase"],
    };
  }

  if (
    /(תשלח|תשלחי|שלח\s*לי|תשלחו|שלח\s*וואטסאפ|שלח\s*מייל|שלח\s*מידע)/u.test(t)
  ) {
    return {
      intent_id: "outbound_send_info",
      intent_type: "outbound",
      score: 90,
      priority: 995,
      matched_triggers: ["send_info_phrase"],
    };
  }

  if (/(כמה\s*זה\s*עולה|מחיר|עלות|כמה\s*עולה)/u.test(t)) {
    return {
      intent_id: "outbound_ask_price",
      intent_type: "outbound",
      score: 90,
      priority: 994,
      matched_triggers: ["pricing_phrase"],
    };
  }

  if (
    /(מה\s*זה\s*עושה|איך\s*זה\s*עובד|למי\s*זה\s*מתאים|תן\s*דוגמה|תני\s*דוגמה|אפשר\s*לשמוע|תסביר|תסבירי|מעניין|נשמע\s*מעניין)/u.test(
      t
    )
  ) {
    return {
      intent_id: "outbound_soft_interest",
      intent_type: "outbound",
      score: 85,
      priority: 993,
      matched_triggers: ["soft_interest_phrase"],
    };
  }

  if (
    /^(הלו|שלום|כן|כן\?|שומע|שומעת|מי\s*זה|מי\s*מדבר|מי\s*מדברת|כן\s*דבר|כן\s*תגיד|כן\s*תגידי)$/u.test(
      t
    )
  ) {
    return {
      intent_id: "other_general",
      intent_type: "other",
      score: 70,
      priority: 992,
      matched_triggers: ["opening_ack"],
    };
  }

  return null;
}

function normalizeIntentId(id) {
  const v = safeText(id).toLowerCase();
  if (!v || v === "other") return "other_general";
  return v;
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

  const prepared = buildVariants(textRaw);
  const lang = opts.forceLang || prepared.lang || "unknown";
  const normalized = prepared.normalized;

  const heuristic = negationHeuristic(normalized);
  if (heuristic) {
    if (opts.logDebug) {
      logger.info("INTENT_DEBUG", {
        lang,
        normalized,
        heuristic,
      });
    }
    return heuristic;
  }

  if (!intents.length) {
    return baseOtherIntent();
  }

  let best = null;

  for (const it of intents) {
    const intentIdRaw = safeText(it?.intent_id);
    const intentId = normalizeIntentId(intentIdRaw);
    const intentType = safeText(it?.intent_type) || "other";
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

    const nv = normalized;
    const compact = nv.replace(/\s+/g, "");

    if (
      intentId === "reports_request" &&
      (/דוחות|דוח|מסמכים|רווח והפסד/u.test(nv) || compact.includes("רווחוהפסד"))
    ) {
      score += 4;
      matched.push("דו\"ח");
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

    if (!best) {
      best = candidate;
      continue;
    }

    if (candidate.score > best.score) {
      best = candidate;
    } else if (candidate.score === best.score) {
      if (candidate.priority > best.priority) {
        best = candidate;
      } else if (candidate.priority === best.priority) {
        if (candidate.intent_id.localeCompare(best.intent_id) < 0) {
          best = candidate;
        }
      }
    }
  }

  if (!best) {
    return baseOtherIntent();
  }

  if (opts.logDebug) {
    logger.info("INTENT_DEBUG", {
      lang,
      normalized,
      variants: prepared.variants,
      best,
    });
  }

  return {
    ...best,
    intent_id: normalizeIntentId(best.intent_id),
  };
}

module.exports = { detectIntent };
