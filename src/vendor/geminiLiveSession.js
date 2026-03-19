"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const {
  ulaw8kB64ToPcm16kB64,
  pcm24kB64ToUlaw8kB64,
} = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const {
  normalizeUtterance,
  detectExplicitLanguageSwitch,
} = require("../logic/hebrewNlp");
const { extractCallerName } = require("../logic/nameExtractor");
const { finalizePipeline } = require("../stage4/finalizePipeline");
const { updateCallerDisplayName } = require("../memory/callerMemory");
const {
  startCallRecording,
  publicRecordingUrl,
  hangupCall,
} = require("../utils/twilioRecordings");
const {
  setRecordingForCall,
  waitForRecording,
  getRecordingForCall,
} = require("../utils/recordingRegistry");
const { getCachedOpening } = require("../logic/openingBuilder");

let passiveCallContext = null;
try {
  passiveCallContext = require("../logic/passiveCallContext");
} catch {
  passiveCallContext = null;
}

function normalizeModelName(m) {
  if (!m) return "";
  return m.startsWith("models/") ? m : `models/${m}`;
}

function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();

  if (!s) return { value: "", withheld: true };

  if (
    ["anonymous", "restricted", "unavailable", "unknown", "private", "withheld"].includes(
      low
    )
  ) {
    return { value: s, withheld: true };
  }

  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function isTruthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isClosingUtterance(text) {
  const t = safeStr(text);
  if (!t) return false;
  if (/(תודה\s*ו?להתראות|להתראות|ביי|נתראה|יום טוב|המשך יום נעים|אשמח לעזור שוב)/.test(t)) return true;
  if (/(спасибо.*до свидания|до свидания|пока)/i.test(t)) return true;
  if (/(thank(s)?\b.*(bye|goodbye)|\bbye\b|\bgoodbye\b)/i.test(t)) return true;
  return false;
}

function buildSettingsContext(settings) {
  const keys = Object.keys(settings || {}).sort();
  return keys.map((k) => `${k}: ${safeStr(settings[k])}`).join("\n").trim();
}

function buildIntentsContext(intents) {
  const rows = Array.isArray(intents) ? intents.slice() : [];
  rows.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    return String(a?.intent_id ?? "").localeCompare(String(a?.intent_id ?? ""));
  });

  return rows
    .map(
      (it) =>
        `- ${safeStr(it.intent_id)} | type=${safeStr(it.intent_type)} | priority=${Number(it.priority ?? 0) || 0} | triggers_he=${safeStr(it.triggers_he)} | triggers_en=${safeStr(it.triggers_en)} | triggers_ru=${safeStr(it.triggers_ru)}`
    )
    .join("\n")
    .trim();
}

function buildSystemInstructionFromSSOT(ssot, runtimeMeta) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const allIntents = Array.isArray(ssot?.intents) ? ssot.intents : [];
  const callType = safeStr(runtimeMeta?.call_type || "inbound").toLowerCase();
  const defaultLang =
    safeStr(runtimeMeta?.language_locked) ||
    safeStr(settings.DEFAULT_LANGUAGE) ||
    "he";
  const callerName =
    safeStr(runtimeMeta?.caller_name) ||
    safeStr(runtimeMeta?.display_name) ||
    safeStr(runtimeMeta?.contact_name) ||
    "";
  const callerWithheld = !!runtimeMeta?.caller_withheld;
  const relevantIntents = callType === "outbound"
    ? allIntents.filter(
        (it) =>
          /^outbound_/i.test(String(it?.intent_id || "")) ||
          /^(sales|outbound|qualification|objection|callback|lead)$/i.test(
            String(it?.intent_type || "")
          )
      )
    : allIntents.filter((it) => !/^outbound_/i.test(String(it?.intent_id || "")));

  const sections = [];

  sections.push(
    [
      "IDENTITY (NON-NEGOTIABLE):",
      "- You are the customer-facing phone representative of Mr.Bot.",
      "- Never say you are AI, model, system, assistant model, or LLM.",
      "- Speak naturally in Hebrew, in short spoken sentences.",
      "- Never output markdown, bullets, JSON, notes, or internal reasoning.",
      "- Every spoken response must be a complete customer-facing sentence.",
      "- Never answer with only the caller name. If you use the caller name, continue with a full sentence in the same turn.",
    ].join("\n")
  );

  sections.push(
    [
      "LANGUAGE POLICY:",
      `- locked_language=${defaultLang}`,
      "- Start and stay in Hebrew unless the caller explicitly asks to switch.",
      "- Do not switch language because of accent or a foreign-sounding name.",
    ].join("\n")
  );

  if (callType === "outbound") {
    sections.push(
      [
        "OUTBOUND CALL MODE (HARD RULES):",
        "- This is an outbound call initiated by Mr.Bot to check relevance for a business phone-answering solution.",
        "- Main value: human-sounding phone answering, virtual receptionist, lead capture, appointment booking, customer service, and sales assistance.",
        "- Do NOT ask 'איך אפשר לעזור' or behave like inbound customer support.",
        "- Your goal is to confirm relevance, understand the business need, explain the service briefly, and move to a sales follow-up if there is interest.",
        "- When the caller asks what the service does, answer concretely in 1-2 short sentences with examples.",
        "- If the caller shares pain like missed calls, lead loss, overload, booking, or customer-service pressure, acknowledge it briefly and explain how Mr.Bot helps.",
        "- Ask only one focused follow-up question at a time.",
        "- If the caller is interested, propose a callback from a sales manager or continuation with more details.",
        "- Never stall, never repeat only the name, and never give one-word answers.",
        "- Never answer in English during a Hebrew outbound call.",
        "- Never say filler like 'רגע, אה'.",
        "- If the caller says they did not understand, answer slowly in one short sentence.",
      ].join("\n")
    );
  } else {
    sections.push(
      [
        "INBOUND CALL MODE (HARD RULES):",
        "- Handle inbound calls briefly and naturally.",
        "- Ask only one question at a time.",
        "- If the call is informational, answer briefly and do not force lead capture.",
      ].join("\n")
    );
  }

  if (callerName) {
    sections.push(
      [
        "CALLER MEMORY POLICY:",
        `- Known caller name: \"${callerName}\"`,
        "- Treat it as correct unless the caller explicitly corrects it.",
        "- Do not ask for the name again unless needed.",
      ].join("\n")
    );
  }

  if (callerWithheld) {
    sections.push(
      [
        "WITHHELD NUMBER POLICY:",
        "- The caller number is withheld/private.",
        "- If callback is needed, collect a callback number explicitly.",
      ].join("\n")
    );
  }

  const promptKeys =
    callType === "outbound"
      ? [
          "OUTBOUND_MASTER_PROMPT",
          "OUTBOUND_GUARDRAILS_PROMPT",
          "QUALIFICATION_PROMPT",
          "OBJECTION_HANDLING_PROMPT",
          "CALLBACK_CAPTURE_PROMPT",
          "OUTBOUND_LEAD_PARSER_PROMPT",
          "SCRIPT_PROFILE_PROMPT",
        ]
      : [
          "MASTER_PROMPT",
          "GUARDRAILS_PROMPT",
          "KB_PROMPT",
          "LEAD_CAPTURE_PROMPT",
          "INTENT_ROUTER_PROMPT",
        ];

  for (const key of promptKeys) {
    if (prompts[key]) sections.push(`${key}:\n${safeStr(prompts[key])}`);
  }

  if (callType === "outbound" && Array.isArray(ssot?.outbound_script) && ssot.outbound_script.length) {
    const scriptLines = ssot.outbound_script
      .slice(0, 12)
      .map((row) => {
        const step = safeStr(row.step || row.Step || row.stage || row.name);
        const desc = safeStr(row.description || row.Description || row.value || row.text);
        const ex = safeStr(row.example_text || row.example || row.sample);
        return `- ${step || "step"}: ${desc}${ex ? ` | example: ${ex}` : ""}`.trim();
      })
      .filter(Boolean)
      .join("\n");
    if (scriptLines) sections.push(`OUTBOUND_SCRIPT:\n${scriptLines}`);
  }

  const settingsContext = buildSettingsContext(settings);
  if (settingsContext) sections.push(`SETTINGS_CONTEXT:\n${settingsContext}`);

  const intentsContext = buildIntentsContext(relevantIntents.length ? relevantIntents : allIntents);
  if (intentsContext) sections.push(`RELEVANT_INTENTS:\n${intentsContext}`);

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function looksLikeReasoningText(text) {
  const t = safeStr(text);
  if (!t) return false;
  return (
    /\*\*.+\*\*/.test(t) ||
    /\b(Composing the Response|Confirming|Implementing|Addressing|Gathering|Finalizing|Prioritizing|Initiating|Acknowledge|Pinpointing|Reasoning|I(?:'| a)m now|I've|I have successfully|I will now|The user is asking|triggering the|based on the context|SETTINGS_CONTEXT|OPENING_SCRIPT|INTENT_ROUTER_PROMPT|LEAD_CAPTURE_PROMPT)\b/i.test(
      t
    )
  );
}

function scrubReasoningText(text) {
  if (!looksLikeReasoningText(text)) return safeStr(text);
  const quoted = safeStr(text).match(/["“](.+?)["”]/);
  if (quoted && quoted[1] && !looksLikeReasoningText(quoted[1])) {
    return quoted[1].trim();
  }
  return "";
}

function wordCount(text) {
  return safeStr(text).split(/\s+/).filter(Boolean).length;
}

function compactText(text) {
  return safeStr(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

function isUnknownOrNoiseUtterance(nlp) {
  const raw = safeStr(nlp?.raw || nlp?.normalized);
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactText(norm);
  if (!compact) return true;
  if (/<noise>|^\.+$/iu.test(raw) || /^\.+$/u.test(norm)) return true;
  if (nlp?.lang === "unknown" && compact.length <= 6) return true;
  if (/^[\u0600-\u06FF]+$/u.test(compact)) return true;
  return false;
}

function compactHeb(text) {
  return safeStr(text).replace(/\s+/g, "").trim();
}

function isGreetingLikeUtterance(nlp) {
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactHeb(norm).toLowerCase();
  if (!norm) return false;
  if (/^(שלום|הלו|היי|כן|מי זה|מה זה)$/u.test(norm)) return true;
  if (/^(hello|helo|hi|hey|alo|halo|hallo|yes)$/iu.test(norm)) return true;
  if (/^(الو|ألو)$/u.test(compact)) return true;
  return /^(שלום|הלו|היי|hello|helo|hi|hey|alo|halo|hallo|الو|ألو)$/iu.test(compact);
}

function isMeaningfulFirstUtterance(nlp) {
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactText(norm);
  if (isUnknownOrNoiseUtterance(nlp)) return isGreetingLikeUtterance(nlp);
  if (isGreetingLikeUtterance(nlp)) return true;
  if (nlp?.lang === "he" && wordCount(norm) >= 1) return true;
  if (compact.length >= 6) return true;
  return false;
}

function isIncompleteOutboundUserUtterance(nlp) {
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactHeb(norm);
  const words = wordCount(norm);
  if (!norm) return true;
  if (isUnknownOrNoiseUtterance(nlp) && !isGreetingLikeUtterance(nlp)) return true;
  if (isGreetingLikeUtterance(nlp)) return false;
  if (words <= 1 && compact.length <= 8) return true;
  if (/^(אני|אבל|רגע|שנייה|מה|כן|לא|אה|או\s*קיי|אוקיי|אוקי|תסבירי|תסביר|מי|מאיפה|אז|זה|את|אתם)$/u.test(norm)) return true;
  if (/^(א ני|א בל|ר גע|ש נייה|מ ה|ת סבירי|מ י|מ איפה)/u.test(norm)) return true;
  if (/(אני לא|אני כן|אבל אבל|אבל אני|תסבירי לי מה|ספרי לי מה|תסבירי לי|ספרי לי|מי את|מי אתם|מאיפה יש|איך הגעת|איך הגעתם|מה אתם|מה את|את יכולה לעזור|יש לי עסק|איזה עסק)/u.test(norm)) return true;
  if (/^(אנילא|אניכן|תסבירילימה|תסביריליקצת|ספרילימה|ספריליקצת|מיאת|מיאתם|מאיפהיש|איךהגעת|איךהגעתם|מהאתם|מהאת|אתיכולהלעזור|ישליעסק|איזהעסק)/.test(compact)) return true;
  if (/[,:-]$/.test(norm)) return true;
  if (!/[.?!]$/.test(norm) && words <= 4 && compact.length < 22) return true;
  if (/^(או\s*קיי|אוקיי|אוקי|הבנתי|בסדר)\.?$/u.test(norm)) return true;
  return false;
}

function shouldIgnoreOutboundUserUtterance(nlp) {
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactHeb(norm);
  if (!norm) return true;
  if (isGreetingLikeUtterance(nlp)) return false;
  if (isUnknownOrNoiseUtterance(nlp)) return true;
  if ((nlp?.lang === "unknown" || nlp?.lang === "en") && compact.length <= 10) return true;
  if (/^\.?$/.test(norm)) return true;
  return false;
}

function isBadBotFragment(text) {
  const norm = safeStr(text);
  if (!norm) return true;
  const compact = compactHeb(norm);
  if (wordCount(norm) <= 1) return true;
  if (/^(שי|shay|רגע,?\s*אה|אה\.?|הממ+|what.*|human-like|okay\.?|ok\.?|להרבה|maybe|alo|hello|hi)$/iu.test(norm)) return true;
  if (/^[A-Za-z ,.'"?!-]+$/.test(norm)) return true;
  if (compact.length < 8) return true;
  return false;
}

function buildScriptedOutboundReply(intent, nlp, meta, ssot) {
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  const compact = compactHeb(norm);
  const intentId = String(intent?.intent_id || "other");
  const settings = ssot?.settings || {};
  const busyTemplate = safeStr(settings.OUTBOUND_IF_BUSY_TEMPLATE);
  const notRelevantTemplate = safeStr(settings.OUTBOUND_IF_NOT_RELEVANT_TEMPLATE);

  if (intentId === "outbound_slow_down" || /(לא\s*הבנתי|לא\s*שמעתי|מהר\s*מדי|דברי\s*לאט|תסבירי\s*יותר\s*לאט|מדברת\s*מהר|תדברי\s*לאט|מפסיקה\s*לדבר|ממשיכה\s*לדבר)/u.test(norm) || /לאהבנתי|מהרמדי|דברילאט|מדברתלימהר|מפסיקהלדבר|ממשיכהלדבר/.test(compact)) {
    return "בטח, אסביר לאט: אנחנו נותנים מענה טלפוני חכם שעונה לשיחות ולוקח פרטים.";
  }
  if (intentId === "outbound_who_are_you" || /(מי\s*אתם|מי\s*את|מה\s*אתם|מה\s*את)/u.test(norm) || /מיאתם|מיאת|מהאתם|מהאת/.test(compact)) {
    return "אני ממיסטר בוט, ואנחנו עוזרים לעסקים לענות לשיחות ולקחת לידים.";
  }
  if (intentId === "outbound_how_did_you_get_to_me" || /(איך\s*הגעת|איך\s*הגעתם|מאיפה\s*יש\s*לך\s*את\s*הטלפון|מאיפה\s*יש\s*לכם\s*את\s*המספר)/u.test(norm) || /איךהגעתאליי|איךהגעתםאליי|מאיפהישלךאתהטלפוןשלי|מאיפהישלכםאתהמספרשלי/.test(compact)) {
    return "המספר הגיע מפרטי קשר עסקיים זמינים, ורציתי רק לבדוק אם זה רלוונטי לעסק שלך.";
  }
  if (intentId === "outbound_what_do_you_offer" || /(מה\s*אתם\s*מציעים|מה\s*את\s*מציעה|מה\s*אתם\s*יכולים|תסבירי\s*לי|ספרי\s*לי|תספרי\s*לי)/u.test(norm) || /מהאתםמציעים|מהאתמציעה|מהאתםיכולים|תסבירילימה|ספריליקצת|תספריליקצת/.test(compact)) {
    return "אנחנו נותנים מענה טלפוני חכם שעונה לשיחות, לוקח פרטים ועוזר בתיאומים ולידים.";
  }
  if (intentId === "outbound_business_context" || /(לעסק\s*שלי|מסעדה|חנות|קליניקה|מרפאה|מרפאת\s*שיניים|משרד|עסק)/u.test(norm) || /לעסקשלי|מרפאתשיניים|חנותפרחים/.test(compact)) {
    if (/מרפאת\s*שיניים|רופא\s*שיניים/u.test(norm) || /מרפאתשיניים/.test(compact)) {
      return "למרפאת שיניים זה יכול להתאים מאוד בקביעת תורים, מענה לשיחות והורדת עומס מהקבלה.";
    }
    if (/מסעדה/u.test(norm)) {
      return "למסעדה זה יכול להתאים מאוד במענה לשיחות, הזמנות ופניות בזמן עומס.";
    }
    if (/חנות/u.test(norm)) {
      return "לחנות זה יכול להתאים מאוד במענה לפניות, תפיסת לידים ושירות גם בזמן עומס.";
    }
    return "כן, זה מתאים לעסקים שמקבלים שיחות ופניות ורוצים מענה רציף בלי להעמיס על הצוות.";
  }
  if (intentId === "outbound_interested" || /(רלוונטי|יכול\s*להתאים|נשמע\s*טוב|חיובי|מעניין)/u.test(norm) || /רלוונטי|יכוללהתאים|נשמעטוב/.test(compact)) {
    return "מעולה, זה יכול לעזור לך לענות לשיחות, לקחת פרטים ולא לפספס פניות.";
  }
  if (intentId === "outbound_callback_later") {
    return busyTemplate || "בשמחה, מתי נוח יותר שנחזור אליך בקצרה?";
  }
  if (intentId === "outbound_not_interested") {
    return notRelevantTemplate || "מובן, תודה רבה ואם זה יהיה רלוונטי בעתיד נשמח לעזור.";
  }
  if (intentId === "outbound_already_has_solution") {
    return "מעולה, ואם תרצו בעתיד חלופה למענה הטלפוני נשמח לעזור.";
  }
  if (/(את יכולה לדבר|את יכולה לעזור|מה זה|מה זה אומר|מה את יכולה לעזור|מה את יכולה לעשות)/u.test(norm) || /אתיכולהלדבר|אתיכולהלעזור|מהזה|מהאתיכולהלעזור/.test(compact)) {
    return "כן, אני יכולה לעזור עם מענה לשיחות, לקיחת פרטים, תיאומים ולידים.";
  }
  return "אנחנו נותנים מענה טלפוני חכם לעסקים, כדי לענות לשיחות ולקחת פרטים בצורה מסודרת.";
}

function isAffirmativeUtterance(text) {
  const t = safeStr(text);
  if (!t) return false;
  return /^(אה,\s*)?(כן([.!?,\s]|$)|נכון([.!?,\s]|$)|אוקיי([.!?,\s]|$)|אוקי([.!?,\s]|$)|בסדר([.!?,\s]|$)|בטח([.!?,\s]|$)|יאללה([.!?,\s]|$))+/u.test(
    t
  );
}

async function deliverWebhook(url, payload, label) {
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    logger.info("Webhook delivered", { label, status: resp.status });
  } catch (e) {
    logger.warn("Webhook delivery failed", { label, error: String(e) });
  }
}

function normHold(existing, extra) {
  const a = safeStr(existing);
  const b = safeStr(extra);
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith(b)) return a;
  return `${a} ${b}`.replace(/\s{2,}/g, " ").trim();
}

function normalizeForDup(text) {
  return safeStr(text)
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:'"()\-]+/g, "")
    .trim()
    .toLowerCase();
}

function looksLikeSpokenOpeningEcho(userText, spokenOpening) {
  const a = normalizeForDup(userText);
  const b = normalizeForDup(spokenOpening);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.includes(a)) return true;
  if (b.length >= 8 && a.includes(b)) return true;
  return false;
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta, ssot }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;
    this.meta = meta || {};
    this.ssot = ssot || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this._skipProactiveOpening = Boolean(this.meta?.skip_proactive_opening);
    this._greetingSent = this._skipProactiveOpening;
    this._openingQueuedUntilFirstUserUtterance = false;
    this._lastScriptedReplyAt = 0;
    this._hangupScheduled = false;
    this._awaitingCallbackConfirmation = false;
    this._closingSentAfterCallback = false;
    this._hasMeaningfulUserTurn = false;
    this._lastAcceptedUserNorm = "";
    this._lastAcceptedUserAt = 0;

    this._langState = {
      lockedLanguage: safeStr(env.MB_DEFAULT_LANGUAGE) || "he",
      candidateLanguage: null,
      candidateHits: 0,
      minConsecutive: Math.max(
        2,
        Number(env.MB_LANGUAGE_SWITCH_MIN_CONSECUTIVE_UTTERANCES || 2)
      ),
    };

    this._trBuf = {
      user: {
        text: "",
        timer: null,
        lastChunk: "",
        lastTs: 0,
        holdKey: "",
        holdRepeats: 0,
        holdStartedAt: 0,
      },
      bot: {
        text: "",
        timer: null,
        lastChunk: "",
        lastTs: 0,
      },
    };

    const callerInfo = normalizeCallerId(this.meta?.caller || "");

    this._call = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "Mr.Bot",
      call_type: safeStr(this.meta?.call_type) || "inbound",
      lead_id: safeStr(this.meta?.lead_id),
      campaign_id: safeStr(this.meta?.campaign_id),
      contact_name: safeStr(this.meta?.contact_name),
      business_name: safeStr(this.meta?.business_name),
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,
      conversationLog: [],
      recording_sid: "",
      finalized: false,
    };

    if (safeStr(this.meta?.spoken_opening)) {
      this._call.conversationLog.push({
        role: "assistant",
        text: safeStr(this.meta.spoken_opening),
        ts: nowIso(),
      });
    }

    this._passiveCtx = null;
    try {
      if (passiveCallContext?.createPassiveCallContext) {
        this._passiveCtx = passiveCallContext.createPassiveCallContext({
          callSid: this._call.callSid,
          streamSid: this._call.streamSid,
          caller: this._call.caller_raw,
          called: this._call.called,
          source: this._call.source,
          caller_profile: this.meta?.caller_profile || null,
        });
      }
    } catch {}
  }

  _clearAllTimers() {
    if (this._trBuf.user.timer) {
      clearTimeout(this._trBuf.user.timer);
      this._trBuf.user.timer = null;
    }
    if (this._trBuf.bot.timer) {
      clearTimeout(this._trBuf.bot.timer);
      this._trBuf.bot.timer = null;
    }
  }

  _resetUserHold() {
    this._trBuf.user.holdKey = "";
    this._trBuf.user.holdRepeats = 0;
    this._trBuf.user.holdStartedAt = 0;
  }

  _registerIncompleteUser(nlp) {
    const holder = this._trBuf.user;
    const key = normalizeForDup(nlp.normalized || nlp.raw);
    const now = Date.now();

    if (!holder.holdKey || holder.holdKey !== key) {
      holder.holdKey = key;
      holder.holdRepeats = 1;
      holder.holdStartedAt = now;
      return false;
    }

    holder.holdRepeats += 1;

    const maxRepeats = Math.max(3, Number(env.MB_USER_HOLD_MAX_REPEATS || 3));
    const maxAgeMs = Math.max(1800, Number(env.MB_USER_HOLD_MAX_MS || 2200));
    const ageMs = now - (holder.holdStartedAt || now);

    if (holder.holdRepeats >= maxRepeats || ageMs >= maxAgeMs) {
      logger.info("Forcing flush for incomplete user utterance", {
        ...this.meta,
        text: nlp.raw,
        normalized: nlp.normalized,
        repeats: holder.holdRepeats,
        age_ms: ageMs,
      });
      this._resetUserHold();
      return true;
    }

    return false;
  }

  start() {
    if (this.ws) return;

    this.ws = new WebSocket(liveWsUrl());

    this.ws.on("open", async () => {
      logger.info("Gemini Live WS connected", this.meta);

      try {
        const r = await startCallRecording(this._call.callSid, logger);
        if (r?.ok && r.recordingSid) {
          this._call.recording_sid = String(r.recordingSid);
          setRecordingForCall(this._call.callSid, {
            recordingSid: this._call.recording_sid,
          });
          logger.info("Recording started + stored in registry", {
            callSid: this._call.callSid,
            recordingSid: this._call.recording_sid,
          });
        }
      } catch (e) {
        logger.warn("startCallRecording failed", { err: String(e) });
      }

      const callerProfile = this.meta?.caller_profile || null;
      const callerName = safeStr(callerProfile?.display_name) || "";

      const systemText = buildSystemInstructionFromSSOT(this.ssot, {
        caller_name: callerName,
        display_name: callerName,
        language_locked: this._langState.lockedLanguage,
        caller_withheld: this._call.caller_withheld,
        call_type: safeStr(this.meta?.call_type) || "inbound",
        contact_name: safeStr(this.meta?.contact_name),
        business_name: safeStr(this.meta?.business_name),
        lead_id: safeStr(this.meta?.lead_id),
      });

      const isOutbound = String(this._call.call_type || "").toLowerCase() === "outbound";
      const ssotPrefix = Number(this.ssot?.settings?.OUTBOUND_VAD_PREFIX_MS || 0);
      const ssotSilence = Number(this.ssot?.settings?.OUTBOUND_VAD_SILENCE_MS || 0);
      const vadPrefix = isOutbound
        ? clampNum(ssotPrefix || env.MB_VAD_PREFIX_MS || 80, 40, 800, 80)
        : clampNum(env.MB_VAD_PREFIX_MS ?? 40, 20, 600, 40);
      const vadSilence = isOutbound
        ? clampNum(ssotSilence || 650, 300, 1800, 650)
        : clampNum(env.MB_VAD_SILENCE_MS ?? 120, 80, 1500, 120);

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          systemInstruction: systemText
            ? { parts: [{ text: systemText }] }
            : undefined,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.1,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName:
                    env.VOICE_NAME_OVERRIDE ||
                    safeStr(this.ssot?.settings?.VOICE_NAME) ||
                    "Kore",
                },
              },
            },
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: vadPrefix,
              silenceDurationMs: vadSilence,
            },
          },
          ...(env.MB_LOG_TRANSCRIPTS ? { inputAudioTranscription: {} } : {}),
        },
      };

      try {
        this.ws.send(JSON.stringify(setup));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", {
          ...this.meta,
          error: e.message,
        });
      }
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (
        !this._skipProactiveOpening &&
        (msg?.setupComplete || msg?.serverContent) &&
        !this._greetingSent &&
        !this._openingQueuedUntilFirstUserUtterance
      ) {
        this._greetingSent = true;
        this._sendProactiveOpening();
      }

      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const inline = p?.inlineData;
          if (
            inline?.data &&
            String(inline?.mimeType || "").startsWith("audio/pcm")
          ) {
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulawB64);
            }
          }

          if (p?.text) {
            const cleaned = scrubReasoningText(String(p.text));
            if (cleaned && this.onGeminiText) this.onGeminiText(cleaned);
            if (cleaned && env.MB_LOG_TRANSCRIPTS) {
              this._onTranscriptChunk("bot", cleaned);
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini message parse error", {
          ...this.meta,
          error: e.message,
        });
      }

      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) this._onTranscriptChunk("user", String(inTr));

        const outTr = msg?.serverContent?.outputTranscription?.text;
        const cleanedOut = scrubReasoningText(String(outTr || ""));
        if (cleanedOut) this._onTranscriptChunk("bot", cleanedOut);
      } catch {}
    });

    this.ws.on("close", async (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;
      this._clearAllTimers();

      this._flushTranscript("user");
      this._flushTranscript("bot");

      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });

      await this._finalizeOnce("gemini_ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", {
        ...this.meta,
        error: err.message,
      });
    });
  }

  _scheduleFlush(who) {
    if (this.closed) return;
    const holder = this._trBuf[who];
    if (holder.timer) clearTimeout(holder.timer);
    const isOutbound = String(this._call?.call_type || "").toLowerCase() === "outbound";
    const delay =
      who === "user"
        ? isOutbound
          ? Math.max(650, Number(env.MB_USER_UTTERANCE_FLUSH_MS || 650))
          : Number(env.MB_USER_UTTERANCE_FLUSH_MS || 700)
        : isOutbound
          ? 700
          : Number(env.MB_BOT_UTTERANCE_FLUSH_MS || 900);
    holder.timer = setTimeout(() => this._flushTranscript(who), delay);
  }

  _onTranscriptChunk(who, chunk) {
    if (!env.MB_LOG_TRANSCRIPTS) return;
    if (this.closed) return;

    const c = safeStr(chunk);
    if (!c) return;
    if (who === "bot" && looksLikeReasoningText(c)) return;

    const holder = this._trBuf[who];
    if (holder.lastChunk === c) return;

    holder.lastChunk = c;
    holder.lastTs = Date.now();

    if (!holder.text) {
      holder.text = c;
    } else if (holder.text.endsWith(c)) {
      // noop
    } else if (c.startsWith(holder.text)) {
      holder.text = c;
    } else {
      holder.text = `${holder.text} ${c}`.replace(/\s{2,}/g, " ");
    }

    this._scheduleFlush(who);
  }

  _applyLanguageDecision(nlp) {
    const explicitSwitch = detectExplicitLanguageSwitch(
      nlp.raw || nlp.normalized || ""
    );
    const outboundMode = String(this._call?.call_type || "").toLowerCase() === "outbound";

    if (explicitSwitch) {
      this._langState.lockedLanguage = explicitSwitch;
      this._langState.candidateLanguage = null;
      this._langState.candidateHits = 0;
    } else if (outboundMode) {
      this._langState.lockedLanguage = "he";
      this._langState.candidateLanguage = null;
      this._langState.candidateHits = 0;
    } else if (
      nlp.lang &&
      nlp.lang !== "unknown" &&
      nlp.lang !== this._langState.lockedLanguage
    ) {
      if (nlp.lang === this._langState.candidateLanguage) {
        this._langState.candidateHits += 1;
      } else {
        this._langState.candidateLanguage = nlp.lang;
        this._langState.candidateHits = 1;
      }

      if (this._langState.candidateHits >= this._langState.minConsecutive) {
        this._langState.lockedLanguage = this._langState.candidateLanguage;
        this._langState.candidateLanguage = null;
        this._langState.candidateHits = 0;
      }
    } else {
      this._langState.candidateLanguage = null;
      this._langState.candidateHits = 0;
    }

    logger.info("LANGUAGE_DECISION", {
      ...this.meta,
      observed_lang: nlp.lang,
      observed_confidence: nlp.lang_confidence,
      explicit_switch: explicitSwitch,
      locked_language: this._langState.lockedLanguage,
      candidate_language: this._langState.candidateLanguage,
      candidate_hits: this._langState.candidateHits,
    });
  }

  _sendImmediateCallbackClosing() {
    if (!this.ws || this.closed || !this.ready) return;
    if (this._closingSentAfterCallback) return;

    this._closingSentAfterCallback = true;

    const msg = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text:
                  "הלקוח אישר לחזור למספר. אמרי עכשיו משפט סיום קצר בעברית, אשרי שהפנייה נרשמה ושהמשרד יחזור, בלי שאלות נוספות ובלי שום טקסט נוסף.",
              },
            ],
          },
        ],
        turnComplete: true,
      },
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.debug("Failed sending immediate callback closing", {
        ...this.meta,
        error: e.message,
      });
    }
  }

  _flushTranscript(who) {
    if (!env.MB_LOG_TRANSCRIPTS) return;

    const holder = this._trBuf[who];
    if (holder.timer) {
      clearTimeout(holder.timer);
      holder.timer = null;
    }

    const text = safeStr(holder.text);
    holder.text = "";
    if (!text) return;

    if (this.closed && who === "user") return;

    const nlp = normalizeUtterance(text);

    if (who === "bot" && looksLikeReasoningText(nlp.raw || nlp.normalized)) {
      return;
    }

    if (who === "bot" && String(this._call.call_type || "").toLowerCase() === "outbound") {
      const norm = safeStr(nlp.normalized || nlp.raw);
      if ((nlp.lang === "en" && this._langState.lockedLanguage === "he") || isBadBotFragment(norm)) {
        logger.info("Ignoring bad bot fragment", {
          ...this.meta,
          text: nlp.raw,
          normalized: nlp.normalized,
          lang: nlp.lang,
        });
        return;
      }
    }

    const role = who === "user" ? "user" : "assistant";

    if (who === "user") {
      if (
        String(this._call.call_type || "").toLowerCase() === "outbound" &&
        safeStr(this.meta?.spoken_opening) &&
        looksLikeSpokenOpeningEcho(nlp.normalized || nlp.raw, this.meta.spoken_opening)
      ) {
        logger.info("Ignoring opening echo as user transcript", {
          ...this.meta,
          text: nlp.raw,
          normalized: nlp.normalized,
        });
        return;
      }

      const dedupNorm = normalizeForDup(nlp.normalized || nlp.raw);
      if (
        dedupNorm &&
        dedupNorm === this._lastAcceptedUserNorm &&
        Date.now() - this._lastAcceptedUserAt < Math.max(1500, Number(env.MB_DUP_USER_TRANSCRIPT_WINDOW_MS || 2500))
      ) {
        logger.info("Ignoring duplicate user transcript", {
          ...this.meta,
          text: nlp.raw,
          normalized: nlp.normalized,
        });
        return;
      }

      this._applyLanguageDecision(nlp);

      if (String(this._call.call_type || "").toLowerCase() === "outbound") {
        const shouldIgnore = shouldIgnoreOutboundUserUtterance(nlp);
        const isIncomplete = isIncompleteOutboundUserUtterance(nlp);

        if (shouldIgnore) {
          return;
        }

        if (isIncomplete) {
          const forceFlush = this._registerIncompleteUser(nlp);
          if (!forceFlush) {
            holder.text = normHold(holder.text, nlp.raw);
            if (!this.closed) this._scheduleFlush("user");
            return;
          }
        } else {
          this._resetUserHold();
        }
      }

      this._lastAcceptedUserNorm = dedupNorm;
      this._lastAcceptedUserAt = Date.now();

      if (isMeaningfulFirstUtterance(nlp)) {
        this._hasMeaningfulUserTurn = true;
      }
    }

    this._call.conversationLog.push({
      role,
      text: nlp.normalized || nlp.raw,
      ts: nowIso(),
    });

    try {
      if (this._passiveCtx && passiveCallContext?.appendUtterance) {
        passiveCallContext.appendUtterance(this._passiveCtx, {
          role,
          text: nlp.raw,
          normalized: nlp.normalized,
          lang: nlp.lang,
        });
      }
    } catch {}

    logger.info(`UTTERANCE ${who}`, {
      ...this.meta,
      text: nlp.raw,
      normalized: nlp.normalized,
      lang: nlp.lang,
      language_locked: this._langState.lockedLanguage,
      lang_confidence: nlp.lang_confidence,
    });

    if (who === "user") {
      try {
        const callerId = safeStr(this.meta?.caller) || "";
        if (callerId) {
          let lastBot = "";
          const logArr = Array.isArray(this._call?.conversationLog)
            ? this._call.conversationLog
            : [];

          for (let i = logArr.length - 2; i >= 0; i -= 1) {
            const it = logArr[i];
            if (it?.role === "assistant" && it.text) {
              lastBot = String(it.text);
              break;
            }
          }

          const found = extractCallerName({
            userText: nlp.normalized || nlp.raw,
            lastBotUtterance: lastBot,
          });

          if (found?.name) {
            const normalizedName =
              String(found.name).trim() === "שאי"
                ? "שי"
                : String(found.name).trim();

            const existing = safeStr(this.meta?.caller_profile?.display_name) || "";

            if (!existing || existing !== normalizedName) {
              updateCallerDisplayName(callerId, normalizedName).catch(() => {});
              if (!this.meta.caller_profile) this.meta.caller_profile = {};
              this.meta.caller_profile.display_name = normalizedName;

              logger.info("CALLER_NAME_CAPTURED", {
                ...this.meta,
                caller: callerId,
                name: normalizedName,
                confidence_reason: found.reason,
                source_utterance: nlp.raw,
              });
            }
          }
        }
      } catch {}

      if (this._awaitingCallbackConfirmation && isAffirmativeUtterance(nlp.normalized || nlp.raw)) {
        this._awaitingCallbackConfirmation = false;
        this._sendImmediateCallbackClosing();
      }

      const intent = detectIntent({
        text: nlp.normalized || nlp.raw,
        intents: this.ssot?.intents || [],
        callType: this._call.call_type,
      });

      logger.info("INTENT_DETECTED", {
        ...this.meta,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        language_locked: this._langState.lockedLanguage,
        intent,
      });

      if (this._maybeHandleOutboundUserTurn(nlp, intent)) {
        return;
      }
    }

    if (who === "bot") {
      const botText = nlp.normalized || nlp.raw;

      if (
        /(לחזור למספר|לחזור אל המספר|לחזור למספר המזוהה|האם לחזור למספר|שנחזור למספר)/u.test(
          botText
        )
      ) {
        this._awaitingCallbackConfirmation = true;
      }

      if (
        env.FORCE_HANGUP_AFTER_CLOSE &&
        !this._hangupScheduled &&
        isClosingUtterance(botText)
      ) {
        const callSid =
          safeStr(this._call?.callSid) || safeStr(this.meta?.callSid);

        if (callSid) {
          this._hangupScheduled = true;
          const graceMs = Math.max(
            15000,
            Number(env.HANGUP_AFTER_CLOSE_GRACE_MS || 15000)
          );

          setTimeout(() => {
            hangupCall(callSid, logger).catch(() => {});
          }, graceMs);

          logger.info("Proactive hangup scheduled", {
            ...this.meta,
            callSid,
            delay_ms: graceMs,
          });
        }
      }
    }

    if (this.onTranscript) {
      this.onTranscript({
        who,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
      });
    }
  }

  _sendExactBotUtterance(text) {
    if (!this.ws || this.closed || !this.ready) return;
    const finalText = safeStr(text);
    if (!finalText) return;
    const msg = {
      clientContent: {
        turns: [{
          role: "user",
          parts: [{
            text: [
              "עני עכשיו בדיוק במשפט הבא, בעברית בלבד, בלי להוסיף שום דבר ובלי לתרגם.",
              "אסור לענות במילה אחת.",
              finalText,
            ].join("\n"),
          }],
        }],
        turnComplete: true,
      },
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {}
  }

  _maybeHandleOutboundUserTurn(nlp, intent) {
    if (String(this._call.call_type || "").toLowerCase() !== "outbound") return false;
    if (Date.now() - this._lastScriptedReplyAt < 900) return true;
    if (shouldIgnoreOutboundUserUtterance(nlp)) return true;

    const recentUsers = (this._call.conversationLog || [])
      .filter((x) => x.role === "user")
      .slice(-3)
      .map((x) => x.text)
      .join(" ");

    const mergedNlp = normalizeUtterance(recentUsers || nlp.raw);

    if (isIncompleteOutboundUserUtterance(mergedNlp)) {
      return false;
    }

    const mergedIntent = detectIntent({
      text: mergedNlp.normalized || mergedNlp.raw,
      intents: this.ssot?.intents || [],
      callType: this._call.call_type,
    });

    const scripted = buildScriptedOutboundReply(mergedIntent, mergedNlp, this.meta, this.ssot);
    if (!scripted) return false;

    this._lastScriptedReplyAt = Date.now();
    this._sendExactBotUtterance(scripted);
    return true;
  }

  _sendProactiveOpening() {
    if (!this.ws || this.closed || !this.ready) return;

    const callerProfile = this.meta?.caller_profile || null;
    let callerName = safeStr(callerProfile?.display_name) || "";
    if (callerName === "שאי") callerName = "שי";

    const totalCalls = Number(callerProfile?.total_calls ?? 0);
    const isReturning = totalCalls > 0;

    const openingPack = getCachedOpening({
      ssot: this.ssot,
      callerName: callerName || safeStr(this.meta?.contact_name),
      isReturning,
      timeZone: env.TIME_ZONE || "Asia/Jerusalem",
      ttlMs: Number(env.MB_OPENING_CACHE_TTL_MS || 300000),
      callType: safeStr(this.meta?.call_type) || "inbound",
      businessName: safeStr(this.meta?.business_name),
    });

    const opening = openingPack.opening;

    const userKickoff = [
      "ענה עכשיו רק במשפט הבא, בדיוק כפי שהוא, בלי הקדמה, בלי הסבר, בלי מחשבות בקול ובלי שום טקסט נוסף.",
      "חובה לענות בעברית בלבד.",
      "אסור לענות במילה אחת, בשם בלבד, או באנגלית.",
      "אחרי המשפט עצור והמתן ללקוח.",
      opening.replace(/\s{2,}/g, " ").trim(),
    ].join("\n");

    const msg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: userKickoff }] }],
        turnComplete: true,
      },
    };

    try {
      this.ws.send(JSON.stringify(msg));
      logger.info("Proactive opening sent", {
        ...this.meta,
        greeting: openingPack.greeting,
        opening_len: opening.length,
        language_locked: this._langState.lockedLanguage,
        opening_cache_hit: openingPack.cache_hit,
      });
    } catch (e) {
      logger.debug("Failed sending proactive opening", {
        ...this.meta,
        error: e.message,
      });
    }
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);
    const msg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: pcm16kB64,
          },
        ],
      },
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.debug("Failed sending audio to Gemini", {
        ...this.meta,
        error: e.message,
      });
    }
  }

  endInput() {
    if (!this.ws || this.closed) return;

    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {}
  }

  async _finalizeOnce(reason) {
    if (this._call.finalized) return;
    this._call.finalized = true;

    try {
      this._clearAllTimers();

      this._call.ended_at = nowIso();
      const durationMs =
        Date.now() - new Date(this._call.started_at).getTime();

      const callMeta = {
        callSid: this._call.callSid,
        streamSid: this._call.streamSid,
        caller: this._call.caller_raw,
        called: this._call.called,
        source: this._call.source,
        started_at: this._call.started_at,
        ended_at: this._call.ended_at,
        duration_ms: durationMs,
        caller_withheld: this._call.caller_withheld,
        finalize_reason: reason || "",
        language_locked: this._langState.lockedLanguage,
        call_type: this._call.call_type || safeStr(this.meta?.call_type) || "inbound",
        lead_id: this._call.lead_id || safeStr(this.meta?.lead_id),
        campaign_id: this._call.campaign_id || safeStr(this.meta?.campaign_id),
        contact_name: this._call.contact_name || safeStr(this.meta?.contact_name),
        business_name: this._call.business_name || safeStr(this.meta?.business_name),
      };

      if (this._passiveCtx && passiveCallContext?.finalizeCtx) {
        try {
          callMeta.passive_context = passiveCallContext.finalizeCtx(
            this._passiveCtx
          );
        } catch {}
      }

      const snapshot = {
        call: callMeta,
        conversationLog: this._call.conversationLog || [],
      };

      await finalizePipeline({
        snapshot,
        ssot: this.ssot,
        env,
        logger,
        senders: {
          sendCallLog: (payload) =>
            deliverWebhook(env.CALL_LOG_WEBHOOK_URL, payload, "CALL_LOG"),
          sendFinal: (payload) =>
            deliverWebhook(env.FINAL_WEBHOOK_URL, payload, "FINAL"),
          sendAbandoned: (payload) =>
            deliverWebhook(env.ABANDONED_WEBHOOK_URL, payload, "ABANDONED"),
          resolveRecording: async () => {
            if (!isTruthyEnv(env.MB_ENABLE_RECORDING)) {
              return {
                recording_provider: null,
                recording_sid: null,
                recording_url_public: null,
              };
            }

            await waitForRecording(this._call.callSid, 12000);

            const rec = getRecordingForCall(this._call.callSid);
            const sid =
              safeStr(rec?.recordingSid || this._call.recording_sid) || null;
            const url = sid ? publicRecordingUrl(sid) : null;

            if (sid) this._call.recording_sid = sid;

            return {
              recording_provider: sid ? "twilio" : null,
              recording_sid: sid,
              recording_url_public: url,
            };
          },
        },
      });
    } catch (e) {
      logger.warn("Finalize failed", { error: String(e) });
    }
  }

  stop() {
    this._finalizeOnce("stop_called").catch(() => {});
    if (!this.ws) return;

    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { GeminiLiveSession };
