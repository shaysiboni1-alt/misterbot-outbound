/**
 * outbound_server.js
 *
 * MisterBot – Outbound Realtime Voice Bot ("נטע")
 * Twilio Media Streams <-> OpenAI Realtime API
 *
 * עקרונות:
 * - הפרדה מלאה מהנכנסות (Server נפרד, Service נפרד).
 * - שפה: עברית כברירת מחדל + מעבר טבעי (MB_LANGUAGES).
 * - Outbound prompts: OUTBOUND_OPENING_SCRIPT + OUTBOUND_GENERAL_PROMPT + OUTBOUND_BUSINESS_PROMPT
 * - סגירה: OUTBOUND_CLOSING_SCRIPT + ניתוק אוטומטי אחרי GRACE (MB_HANGUP_GRACE_MS)
 * - Status/Lead/Webhooks: לא שוברים לכם כלום — מוסיפים OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL לסיכום "מעוניין"
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- ENV --------------------
const PORT = parseInt(process.env.PORT || "10000", 10);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.OUTBOUND_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// OUTBOUND prompts
const OUTBOUND_OPENING_SCRIPT = (process.env.OUTBOUND_OPENING_SCRIPT || "").trim();
const OUTBOUND_GENERAL_PROMPT = (process.env.OUTBOUND_GENERAL_PROMPT || "").trim();
const OUTBOUND_BUSINESS_PROMPT = (process.env.OUTBOUND_BUSINESS_PROMPT || "").trim();
const OUTBOUND_CLOSING_SCRIPT = (process.env.OUTBOUND_CLOSING_SCRIPT || "").trim();

// Shared behavior controls (reuse existing group)
const MB_LANGUAGES = (process.env.MB_LANGUAGES || "he,en,ru,ar").trim();
const MB_HANGUP_AFTER_GOODBYE = String(process.env.MB_HANGUP_AFTER_GOODBYE || "true") === "true";
const MB_HANGUP_GRACE_MS = parseInt(process.env.MB_HANGUP_GRACE_MS || "4000", 10);

// idle / max call
const MB_IDLE_WARNING_MS = parseInt(process.env.MB_IDLE_WARNING_MS || "60000", 10);
const MB_IDLE_HANGUP_MS = parseInt(process.env.MB_IDLE_HANGUP_MS || "20000", 10);
const MB_MAX_CALL_MS = parseInt(process.env.MB_MAX_CALL_MS || "500000", 10);
const MB_MAX_WARN_BEFORE_MS = parseInt(process.env.MB_MAX_WARN_BEFORE_MS || "45000", 10);

// VAD
const MB_VAD_THRESHOLD = parseFloat(process.env.MB_VAD_THRESHOLD || "0.75");
const MB_VAD_PREFIX_MS = parseInt(process.env.MB_VAD_PREFIX_MS || "200", 10);
const MB_VAD_SILENCE_MS = parseInt(process.env.MB_VAD_SILENCE_MS || "900", 10);
const MB_VAD_SUFFIX_MS = parseInt(process.env.MB_VAD_SUFFIX_MS || "150", 10);

// Optional webhooks
const OUTBOUND_STATUS_WEBHOOK_URL = (process.env.OUTBOUND_STATUS_WEBHOOK_URL || "").trim();
const OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL = (process.env.OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL || "").trim();

// Existing lead webhook (מהקבוצה הקיימת שלכם)
const MB_ENABLE_LEAD_CAPTURE = String(process.env.MB_ENABLE_LEAD_CAPTURE || "false") === "true";
const MB_LEADS_AIRTABLE_WEBHOOK_URL = (process.env.MB_LEADS_AIRTABLE_WEBHOOK_URL || "").trim();

// Health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// -------------------- Helpers --------------------
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function nowIso() {
  return new Date().toISOString();
}

async function postJson(url, payload) {
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const t = await r.text();
    return { ok: r.ok, status: r.status, text: t };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Very small “summary” fallback if OpenAI fails
function fallbackSummary(call) {
  const name = call.full_name || "";
  const topic = call.intent_summary || "התעניינות כללית";
  const need = call.pain_points?.slice(0, 3).join(", ") || "לא צוין";
  const next = call.next_step || "לחזרה של נציג";
  return `סיכום שיחה${name ? " עם " + name : ""}: ${topic}. כאב/צורך: ${need}. המשך: ${next}.`;
}

// Ask OpenAI (text) for a WhatsApp-style summary
async function generateClientSummary({ transcriptText, full_name, phone, business_type, pain_points }) {
  if (!OPENAI_API_KEY) return null;

  const model = process.env.OUTBOUND_SUMMARY_MODEL || "gpt-4.1-mini";
  const sys = `את/ה כותב/ת סיכום קצר מאוד בעברית (עד 5 שורות) לבעל עסק אחרי שיחת מכירה.
הסיכום צריך להיות ברור, תמציתי, כולל נקודות:
- מי דיבר (אם יש שם)
- מה סוג העסק (אם ידוע)
- מה הכאב/צורך המרכזי
- מה בקשת הלקוח/השלב הבא
בלי מחירים. בלי שמות לקוחות אחרים.`;

  const user = `פרטים:
שם: ${full_name || "לא ידוע"}
טלפון: ${phone || "לא ידוע"}
סוג עסק: ${business_type || "לא ידוע"}
כאבים/צרכים: ${(pain_points && pain_points.length) ? pain_points.join(", ") : "לא ידוע"}

תמלול (אם יש):
${transcriptText || "(אין תמלול מלא)"}
`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

// -------------------- Realtime WS Bridge --------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/twilio-media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  socket.destroy();
});

wss.on("connection", async (twilioWs, req) => {
  // Read query params passed by Twilio <Connect><Stream> URL
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const direction = urlObj.searchParams.get("direction") || "outbound";
  const outbound_id = urlObj.searchParams.get("outbound_id") || "";
  const campaign = urlObj.searchParams.get("campaign") || "";
  const to = urlObj.searchParams.get("to") || "";
  const from = urlObj.searchParams.get("from") || "";
  const full_name = urlObj.searchParams.get("full_name") || "";

  const call = {
    started_at: nowIso(),
    direction,
    outbound_id,
    campaign,
    to,
    from,
    full_name,
    twilio_stream_sid: "",
    call_sid: "",
    transcript: [],
    transcriptText: "",
    interested: false,
    collected: {
      full_name: full_name || "",
      business_name: "",
      phone: "",
      reason: "",
      business_type: "",
      pain_points: []
    },
    intent_summary: "",
    next_step: ""
  };

  // Timers
  let idleWarnTimer = null;
  let idleHangTimer = null;
  let maxCallTimer = null;
  let maxCallWarnTimer = null;

  function resetIdleTimers() {
    if (idleWarnTimer) clearTimeout(idleWarnTimer);
    if (idleHangTimer) clearTimeout(idleHangTimer);

    idleWarnTimer = setTimeout(() => {
      // gentle prompt
      sendAssistantText("רַק לְוַדֵּא שֶׁאֲנִי שׁוֹמַעַת… אֲנַחְנוּ עִדַּיְן בְּקוֹ?");

    }, MB_IDLE_WARNING_MS);

    idleHangTimer = setTimeout(() => {
      // close
      if (OUTBOUND_CLOSING_SCRIPT) sendAssistantText(OUTBOUND_CLOSING_SCRIPT);
      if (MB_HANGUP_AFTER_GOODBYE) scheduleHangup();
    }, MB_IDLE_HANGUP_MS);
  }

  function scheduleHangup() {
    setTimeout(() => {
      try { twilioWs.close(); } catch {}
    }, Math.max(500, MB_HANGUP_GRACE_MS));
  }

  function setMaxTimers() {
    if (maxCallTimer) clearTimeout(maxCallTimer);
    if (maxCallWarnTimer) clearTimeout(maxCallWarnTimer);

    maxCallWarnTimer = setTimeout(() => {
      sendAssistantText("רַק מְעַדְכֶּנֶת בְּקָצָרָה— עוֹד רֶגַע אֲנִי מְסַיֶּמֶת וּמַעֲבִירָה לְנָצִיג.");
    }, Math.max(0, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS));

    maxCallTimer = setTimeout(() => {
      if (OUTBOUND_CLOSING_SCRIPT) sendAssistantText(OUTBOUND_CLOSING_SCRIPT);
      if (MB_HANGUP_AFTER_GOODBYE) scheduleHangup();
    }, MB_MAX_CALL_MS);
  }

  // OpenAI Realtime WS
  let openaiWs = null;
  let openaiReady = false;

  function sendToTwilioAudio(base64Audio) {
    // Twilio expects:
    // { event: "media", media: { payload: "<base64>" } }
    const msg = {
      event: "media",
      media: { payload: base64Audio }
    };
    try { twilioWs.send(JSON.stringify(msg)); } catch {}
  }

  function sendAssistantText(text) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: text
      }
    }));
  }

  async function connectOpenAI() {
    if (!OPENAI_API_KEY) {
      // if no key, just close
      try { twilioWs.close(); } catch {}
      return;
    }

    openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(REALTIME_MODEL), {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    openaiWs.on("open", () => {
      // Configure session
      const instructions =
        [
          OUTBOUND_GENERAL_PROMPT,
          "",
          "ידע עסקי (לשאלות ותשובות):",
          OUTBOUND_BUSINESS_PROMPT
        ].filter(Boolean).join("\n");

      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions,
          // Twilio stream is 8k uLaw
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // server-side VAD tuned by ENV
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
            silence_duration_ms: MB_VAD_SILENCE_MS,
            // suffix not always supported; safe to include as metadata
          }
        }
      }));

      openaiReady = true;

      // Speak opening
      let opening = OUTBOUND_OPENING_SCRIPT || "הַיֵּי… הַאִם הִגַּעְתִּי לְבַעַל/ת הָעֵסֶק?";
      if (opening.includes("{FULL_NAME}")) {
        const name = (call.full_name || "").trim();
        if (name) opening = opening.replaceAll("{FULL_NAME}", name);
        else opening = "הַיֵּי… (הַפְסָקָה קְצָרָה) הַאִם הִגַּעְתִּי לְבַעַל/ת הָעֵסֶק?";
      }

      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: opening
        }
      }));
    });

    openaiWs.on("message", (raw) => {
      const msg = safeJsonParse(raw.toString());
      if (!msg) return;

      // audio chunks from OpenAI -> Twilio
      if (msg.type === "response.audio.delta" && msg.delta) {
        sendToTwilioAudio(msg.delta);
        return;
      }

      // transcript (best effort)
      if (msg.type === "response.text.delta" && msg.delta) {
        call.transcriptText += msg.delta;
        return;
      }

      // final text
      if (msg.type === "response.text.done" && msg.text) {
        call.transcriptText += "\n";
        return;
      }

      // When OpenAI thinks conversation should end
      if (msg.type === "response.done") {
        // no-op
        return;
      }
    });

    openaiWs.on("close", () => {
      openaiReady = false;
      try { twilioWs.close(); } catch {}
    });

    openaiWs.on("error", () => {
      openaiReady = false;
      try { twilioWs.close(); } catch {}
    });
  }

  // Kick
  resetIdleTimers();
  setMaxTimers();
  await connectOpenAI();

  // Handle Twilio inbound stream events
  twilioWs.on("message", async (raw) => {
    resetIdleTimers();

    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    if (msg.event === "start") {
      call.twilio_stream_sid = msg?.start?.streamSid || "";
      call.call_sid = msg?.start?.callSid || "";
      // optional: send status webhook
      if (OUTBOUND_STATUS_WEBHOOK_URL) {
        await postJson(OUTBOUND_STATUS_WEBHOOK_URL, {
          ts: nowIso(),
          type: "stream_start",
          outbound_id: call.outbound_id,
          campaign: call.campaign,
          call_sid: call.call_sid,
          stream_sid: call.twilio_stream_sid,
          to: call.to,
          from: call.from
        });
      }
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !openaiReady) return;

      // Forward audio to OpenAI
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
      return;
    }

    if (msg.event === "stop") {
      // stream ended
      try { openaiWs && openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", async () => {
    // cleanup timers
    try { if (idleWarnTimer) clearTimeout(idleWarnTimer); } catch {}
    try { if (idleHangTimer) clearTimeout(idleHangTimer); } catch {}
    try { if (maxCallTimer) clearTimeout(maxCallTimer); } catch {}
    try { if (maxCallWarnTimer) clearTimeout(maxCallWarnTimer); } catch {}

    // final status
    if (OUTBOUND_STATUS_WEBHOOK_URL) {
      await postJson(OUTBOUND_STATUS_WEBHOOK_URL, {
        ts: nowIso(),
        type: "stream_end",
        outbound_id: call.outbound_id,
        campaign: call.campaign,
        call_sid: call.call_sid,
        to: call.to,
        from: call.from
      });
    }

    // Lead + client summary logic:
    // כרגע “interest” נקבע בפועל אצלכם דרך Airtable/flow.
    // כדי לא לשבור כלום, אנחנו שולחים סיכום רק אם יש:
    // - MB_ENABLE_LEAD_CAPTURE=true
    // - ויש webhook של לידים
    // - ויש OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL
    // - ויש לפחות טלפון/שם כלשהו (fallback: from/to)
    //
    // אם אתם רוצים חיווי "מעוניין" קשיח: נוכל לקשור את זה ל-Airtable status שמגיע ל-StatusCallback,
    // או להוסיף parsing חכם בהמשך. כרגע זה safe.

    const phoneFallback = (call.collected.phone || call.to || call.from || "").trim();
    const fullNameFallback = (call.collected.full_name || call.full_name || "").trim();

    const shouldSendLead = MB_ENABLE_LEAD_CAPTURE && MB_LEADS_AIRTABLE_WEBHOOK_URL;
    const shouldSendClientSummary = shouldSendLead && OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL && phoneFallback;

    if (shouldSendLead) {
      await postJson(MB_LEADS_AIRTABLE_WEBHOOK_URL, {
        ts: nowIso(),
        direction: "outbound",
        outbound_id: call.outbound_id,
        campaign: call.campaign,
        call_sid: call.call_sid,
        from: call.from,
        to: call.to,
        full_name: fullNameFallback,
        phone: phoneFallback,
        transcript: (call.transcriptText || "").slice(0, 20000)
      });
    }

    if (shouldSendClientSummary) {
      const summaryText =
        (await generateClientSummary({
          transcriptText: call.transcriptText,
          full_name: fullNameFallback,
          phone: phoneFallback,
          business_type: call.collected.business_type,
          pain_points: call.collected.pain_points
        })) || fallbackSummary(call);

      await postJson(OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL, {
        ts: nowIso(),
        outbound_id: call.outbound_id,
        campaign: call.campaign,
        call_sid: call.call_sid,
        phone: phoneFallback,
        full_name: fullNameFallback,
        summary: summaryText
      });
    }
  });

  twilioWs.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`✅ MisterBot OUTBOUND server listening on :${PORT}`);
});
