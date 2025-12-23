// outbound_server.js
//
// MisterBot Realtime OUTBOUND Voice Bot – "נטע" (שיחות יוצאות)
// Twilio Calls API -> TwiML -> Media Streams <-> OpenAI Realtime
//
// ❗ מופרד לחלוטין מה-INBOUND
// ❗ עובד עם ENV של Render (בלי dotenv)
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
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('PORT', 3001);
const DOMAIN = process.env.OUTBOUND_DOMAIN || '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing Twilio credentials');
  process.exit(1);
}

// Identity
const BOT_NAME = process.env.OUTBOUND_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.OUTBOUND_BUSINESS_NAME || 'MisterBot';

// Scripts
const OUTBOUND_OPENING_SCRIPT =
  process.env.OUTBOUND_OPENING_SCRIPT ||
  'היי… מדברת נטע ממיסטר בוט. האם אני מדברת עם ${LEAD_NAME}?';

const OUTBOUND_CLOSING_SCRIPT =
  process.env.OUTBOUND_CLOSING_SCRIPT ||
  'תודה רבה, יום נעים ולהתראות.';

const OUTBOUND_GENERAL_PROMPT = process.env.OUTBOUND_GENERAL_PROMPT || '';
const OUTBOUND_BUSINESS_PROMPT = process.env.OUTBOUND_BUSINESS_PROMPT || '';

// Voice / VAD
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Hangup / timing
const HANGUP_GRACE_MS = envNumber('OUTBOUND_HANGUP_GRACE_MS', 4000);
const MAX_CALL_MS = envNumber('OUTBOUND_MAX_CALL_MS', 5 * 60 * 1000);

// -----------------------------
// Helpers
// -----------------------------
function formatTemplate(str, vars) {
  return String(str).replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

// -----------------------------
// TwiML – שיחה יוצאת
// -----------------------------
app.post('/outbound/twilio-voice', (req, res) => {
  const host = DOMAIN || req.headers.host;

  const wsUrl = `wss://${host}/outbound-media-stream`;

  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="leadName" value="${req.query.leadName || ''}" />
      <Parameter name="recordId" value="${req.query.recordId || ''}" />
    </Stream>
  </Connect>
</Response>
  `.trim();

  res.type('text/xml').send(twiml);
});

// -----------------------------
// Server
// -----------------------------
const server = http.createServer(app);

// -----------------------------
// WebSocket – Media Stream
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/outbound-media-stream' });

wss.on('connection', (ws) => {
  let openAiWs;
  let callEnded = false;

  openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openAiWs.on('open', () => {
    const instructions = `
${OUTBOUND_GENERAL_PROMPT}

${OUTBOUND_BUSINESS_PROMPT}

כללים:
- זו שיחה יוזמת
- אם לא מעוניינים – לכבד ולסיים
- לא לדבר על מחירים, רק מודל
    `.trim();

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
          content: [{ type: 'input_text', text: OUTBOUND_OPENING_SCRIPT }]
        }
      })
    );

    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  });

  ws.on('message', (data) => {
    if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
    openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: JSON.parse(data).media?.payload }));
  });

  ws.on('close', () => {
    if (!callEnded) {
      callEnded = true;
      setTimeout(() => {
        try { openAiWs.close(); } catch {}
      }, HANGUP_GRACE_MS);
    }
  });
});

// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ OUTBOUND server running on ${PORT}`);
});
