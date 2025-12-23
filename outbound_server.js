// outbound_server.js
//
// MisterBot Realtime OUTBOUND Voice Bot – "נטע" (שיחות יוצאות)
// Twilio -> Media Streams <-> OpenAI Realtime
//
// ❗ מופרד לחלוטין מה-INBOUND
// ❗ לא משתמש ב-dotenv בכלל (כדי שלא ייפול על Render)
//
// Start: node outbound_server.js
//

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase().trim();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('PORT', 3001);

/**
 * OUTBOUND_DOMAIN:
 * לשים רק דומיין בלי https://
 * דוגמה: misterbot-outbound.onrender.com
 */
const DOMAIN = (process.env.OUTBOUND_DOMAIN || '').trim();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// Prompts / scripts
const OUTBOUND_OPENING_SCRIPT = (process.env.OUTBOUND_OPENING_SCRIPT || '').trim();
const OUTBOUND_CLOSING_SCRIPT = (process.env.OUTBOUND_CLOSING_SCRIPT || 'תּוֹדָה רַבָּה, יוֹם נָעִים וּלְהִתְרָאוֹת.').trim();

const OUTBOUND_GENERAL_PROMPT = (process.env.OUTBOUND_GENERAL_PROMPT || '').trim();
const OUTBOUND_BUSINESS_PROMPT = (process.env.OUTBOUND_BUSINESS_PROMPT || '').trim();

// Languages
const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he').trim();

// Behavior / timing
const OUTBOUND_HANGUP_GRACE_MS = envNumber('OUTBOUND_HANGUP_GRACE_MS', 4000);
const OUTBOUND_MAX_CALL_MS = envNumber('OUTBOUND_MAX_CALL_MS', 5 * 60 * 1000);

const OUTBOUND_STATUS_WEBHOOK_URL = (process.env.OUTBOUND_STATUS_WEBHOOK_URL || '').trim();
const OUTBOUND_ENABLE_STATUS_WEBHOOK = envBool('OUTBOUND_ENABLE_STATUS_WEBHOOK', true);

// OpenAI Realtime
const OPENAI_REALTIME_MODEL = (process.env.OUTBOUND_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17').trim();
const OPENAI_VOICE = (process.env.OPENAI_VOICE || 'alloy').trim();

// VAD (משתמשים במה שכבר יש לכם בקבוצה)
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 150);
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);

// -----------------------------
// Webhook helper (אם תרצה סטטוסים)
// -----------------------------
async function postJson(url, payload) {
  if (!url) return;
  const fetch = require('node-fetch'); // dependency exists אצלכם
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('⚠️ webhook post failed:', e?.message || e);
  }
}

function buildHost(req) {
  return DOMAIN || req.headers.host;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

/**
 * אם אי פעם תרצה TwiML מ-Render (לא חובה כי אתם משתמשים ב-Twilio Function),
 * זה endpoint מוכן:
 * POST https://<OUTBOUND_DOMAIN>/outbound/twilio-voice
 */
app.post('/outbound/twilio-voice', (req, res) => {
  const host = buildHost(req);
  const wsUrl = `wss://${host}/outbound-media-stream`;

  const fullName = (req.query.full_name || req.query.fullName || req.query.leadName || '').toString();
  const outboundId = (req.query.outbound_id || req.query.outboundId || req.query.recordId || '').toString();

  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="direction" value="outbound" />
      <Parameter name="full_name" value="${escapeXml(fullName)}" />
      <Parameter name="outbound_id" value="${escapeXml(outboundId)}" />
    </Stream>
  </Connect>
</Response>
  `.trim();

  res.type('text/xml').send(twiml);
});

// -----------------------------
// HTTP server + WS
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/outbound-media-stream' });

wss.on('connection', (twilioWs) => {
  const startedAt = Date.now();
  let callSid = '';
  let streamSid = '';
  let fullName = '';
  let outboundId = '';

  let openAiWs = null;
  let closed = false;

  function closeAll(reason) {
    if (closed) return;
    closed = true;

    try {
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}

    if (OUTBOUND_ENABLE_STATUS_WEBHOOK && OUTBOUND_STATUS_WEBHOOK_URL) {
      postJson(OUTBOUND_STATUS_WEBHOOK_URL, {
        event: 'outbound_closed',
        reason: reason || 'closed',
        callSid,
        streamSid,
        outboundId,
        fullName,
        durationMs: Date.now() - startedAt
      });
    }
  }

  const maxTimer = setTimeout(() => closeAll('max_call_time'), OUTBOUND_MAX_CALL_MS);

  function buildOpening(name) {
    const tpl =
      OUTBOUND_OPENING_SCRIPT ||
      'הַי… (הַפְסָקָה שֶׁל שְׁנִיָּה) הַאִם אֲנִי מְדַבֶּרֶת עִם ${FULL_NAME}?';
    const safeName = (name || '').trim();
    return tpl.replace(/\$\{FULL_NAME\}/g, safeName || '...');
  }

  function buildInstructions(openingText) {
    return `
אַתֶּם "נֶטָּע" — בּוֹט קוֹלִי שָׂמֵחַ, אֲמִתִּי וּמְכִירָתִי, בְּלָשׁוֹן רַבִּים.
זוֹ שִׂיחָה יוֹזֶמֶת (שִׂיחָה יוֹצֵאת).

שָׂפוֹת מוּתָּרוֹת: ${MB_LANGUAGES}.
בְּרִירַת מֶחְדָּל: עִבְרִית. אִם הָאָדָם עוֹנֶה בְּאַנְגְּלִית/רוּסִית/עֲרָבִית — תַּעַבְרוּ בִּטְבִיעוּת לְאוֹתָהּ שָׂפָה.

פְּתִיחַ (נאמר): "${openingText}"

כללים קריטיים:
- אם לא מעוניינים: לכבד ולסיים.
- לא לדבר על מחירים, רק להסביר מודל (דקות/חבילות) ולהעביר לנציג.
- בסיום: לומר רק את הסגיר ואז לסיים. הסגיר:
"${OUTBOUND_CLOSING_SCRIPT}"

הפרומפט הכללי:
${OUTBOUND_GENERAL_PROMPT}

הפרומפט העסקי:
${OUTBOUND_BUSINESS_PROMPT}
`.trim();
  }

  twilioWs.on('message', (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg || !msg.event) return;

    if (msg.event === 'start') {
      callSid = msg.start?.callSid || '';
      streamSid = msg.start?.streamSid || '';
      const cp = msg.start?.customParameters || {};

      fullName = (cp.full_name || cp.fullName || '').toString();
      outboundId = (cp.outbound_id || cp.outboundId || '').toString();

      // OpenAI WS
      openAiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );

      openAiWs.on('open', () => {
        const openingText = buildOpening(fullName);
        const instructions = buildInstructions(openingText);

        openAiWs.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['audio', 'text'],
              voice: OPENAI_VOICE,
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              turn_detection: {
                type: 'server_vad',
                threshold: MB_VAD_THRESHOLD,
                silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
                prefix_padding_ms: MB_VAD_PREFIX_MS
              },
              instructions
            }
          })
        );

        openAiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: openingText }]
            }
          })
        );
        openAiWs.send(JSON.stringify({ type: 'response.create' }));

        if (OUTBOUND_ENABLE_STATUS_WEBHOOK && OUTBOUND_STATUS_WEBHOOK_URL) {
          postJson(OUTBOUND_STATUS_WEBHOOK_URL, {
            event: 'outbound_started',
            callSid,
            streamSid,
            outboundId,
            fullName
          });
        }
      });

      openAiWs.on('message', (evtRaw) => {
        const evt = safeJsonParse(evtRaw);
        if (!evt) return;

        if (evt.type === 'response.audio.delta' && evt.delta) {
          twilioWs.send(
            JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: evt.delta }
            })
          );
          return;
        }

        if (MB_ALLOW_BARGE_IN && evt.type === 'input_audio_buffer.speech_started') {
          try {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          } catch {}
        }
      });

      openAiWs.on('close', () => {
        setTimeout(() => closeAll('openai_closed'), OUTBOUND_HANGUP_GRACE_MS);
      });

      openAiWs.on('error', (e) => {
        console.error('OpenAI WS error:', e?.message || e);
        setTimeout(() => closeAll('openai_error'), 200);
      });

      return;
    }

    if (msg.event === 'media') {
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (msg.event === 'stop') {
      closeAll('twilio_stop');
    }
  });

  twilioWs.on('close', () => closeAll('twilio_closed'));
  twilioWs.on('error', () => closeAll('twilio_error'));

  twilioWs.on('close', () => clearTimeout(maxTimer));
  twilioWs.on('error', () => clearTimeout(maxTimer));
});

// -----------------------------
// Start
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot OUTBOUND server listening on port ${PORT}`);
});
