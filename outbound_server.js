// outbound_server.js
//
// MisterBot Realtime OUTBOUND Voice Bot – "נטע" (שיחות יוצאות)
// Twilio Calls API -> TwiML -> Media Streams <-> OpenAI Realtime
//
// ❗ מופרד לחלוטין מה-INBOUND (ריפו ושירות נפרדים)
//
// Start: node outbound_server.js
//

/**
 * dotenv: ברנדר זה לא חובה, אבל אם מריצים לוקאלית זה נוח.
 * אם dotenv לא מותקן/לא קיים — לא נופלים.
 */
try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch (e) {
  // ignore
}

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

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('PORT', 3001);

/**
 * OUTBOUND_DOMAIN:
 * לשים רק דומיין בלי https://
 * לדוגמה: misterbot-outbound.onrender.com
 */
const DOMAIN = (process.env.OUTBOUND_DOMAIN || '').trim();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// Scripts / prompts (יוצא)
const OUTBOUND_OPENING_SCRIPT = (process.env.OUTBOUND_OPENING_SCRIPT || '').trim();
const OUTBOUND_CLOSING_SCRIPT = (process.env.OUTBOUND_CLOSING_SCRIPT || 'תּוֹדָה רַבָּה, יוֹם נָעִים וּלְהִתְרָאוֹת.').trim();

const OUTBOUND_GENERAL_PROMPT = (process.env.OUTBOUND_GENERAL_PROMPT || '').trim();
const OUTBOUND_BUSINESS_PROMPT = (process.env.OUTBOUND_BUSINESS_PROMPT || '').trim();

// Languages (משתמשים במה שכבר יש לכם)
const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he').trim();

// Behavior / timing
const OUTBOUND_HANGUP_GRACE_MS = envNumber('OUTBOUND_HANGUP_GRACE_MS', 4000);
const OUTBOUND_MAX_CALL_MS = envNumber('OUTBOUND_MAX_CALL_MS', 5 * 60 * 1000);
const OUTBOUND_ENABLE_STATUS_WEBHOOK = envBool('OUTBOUND_ENABLE_STATUS_WEBHOOK', true);
const OUTBOUND_STATUS_WEBHOOK_URL = (process.env.OUTBOUND_STATUS_WEBHOOK_URL || '').trim();

// OpenAI Realtime config
const OPENAI_REALTIME_MODEL = (process.env.OUTBOUND_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17').trim();
const OPENAI_VOICE = (process.env.OPENAI_VOICE || 'alloy').trim();

const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 150);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);

// -----------------------------
// Helpers
// -----------------------------
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildHost(req) {
  // אם שמתם OUTBOUND_DOMAIN – נשתמש בו תמיד (מומלץ).
  // אחרת נשתמש ב-host של הבקשה (עובד לרוב).
  return DOMAIN || req.headers.host;
}

async function postJson(url, payload) {
  if (!url) return;
  // node-fetch v2
  const fetch = require('node-fetch'); // eslint-disable-line global-require
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

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

/**
 * TwiML endpoint לשיחות יוצאות (משמש את Twilio Voice Function /voice_misterbot_outbound אם תרצו,
 * או ישירות Calls API).
 *
 * הקישור צריך להיות:
 *   https://misterbot-outbound.onrender.com/outbound/twilio-voice
 */
app.post('/outbound/twilio-voice', (req, res) => {
  const host = buildHost(req);
  const wsUrl = `wss://${host}/outbound-media-stream`;

  // אפשר להעביר פרמטרים דרך querystring או Twilio <Parameter>:
  const leadName = (req.query.full_name || req.query.leadName || '').toString();
  const recordId = (req.query.recordId || req.query.outbound_id || '').toString();

  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="direction" value="outbound" />
      <Parameter name="full_name" value="${escapeXml(leadName)}" />
      <Parameter name="outbound_id" value="${escapeXml(recordId)}" />
    </Stream>
  </Connect>
</Response>
  `.trim();

  res.type('text/xml').send(twiml);
});

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -----------------------------
// Server + WebSocket (Twilio Media Streams)
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/outbound-media-stream' });

wss.on('connection', (twilioWs, req) => {
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
        event: 'outbound_stream_closed',
        reason: reason || 'closed',
        callSid,
        streamSid,
        outboundId,
        fullName,
        durationMs: Date.now() - startedAt
      });
    }
  }

  // Hard safety max call time
  const maxTimer = setTimeout(() => {
    closeAll('max_call_time');
  }, OUTBOUND_MAX_CALL_MS);

  twilioWs.on('message', (msg) => {
    const data = safeJsonParse(msg);
    if (!data || !data.event) return;

    if (data.event === 'start') {
      callSid = data.start?.callSid || '';
      streamSid = data.start?.streamSid || '';

      // Twilio <Parameter> מגיע בתוך start.customParameters
      const cp = data.start?.customParameters || {};
      fullName = (cp.full_name || cp.fullName || '').toString();
      outboundId = (cp.outbound_id || cp.outboundId || '').toString();

      // פותחים OpenAI Realtime אחרי start כדי שנדע פרטים
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
        const opening = renderOpening(fullName);

        const instructions = buildInstructions({
          languages: MB_LANGUAGES,
          opening,
          closing: OUTBOUND_CLOSING_SCRIPT
        });

        // Session update
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

        // Push opening as user message -> force assistant speak it
        openAiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: opening }]
            }
          })
        );
        openAiWs.send(JSON.stringify({ type: 'response.create' }));

        if (OUTBOUND_ENABLE_STATUS_WEBHOOK && OUTBOUND_STATUS_WEBHOOK_URL) {
          postJson(OUTBOUND_STATUS_WEBHOOK_URL, {
            event: 'outbound_call_started',
            callSid,
            streamSid,
            outboundId,
            fullName
          });
        }
      });

      openAiWs.on('message', (raw) => {
        const evt = safeJsonParse(raw);
        if (!evt) return;

        // audio delta -> send to Twilio
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

        // אם רוצים barge-in: כשמשתמש מדבר (input_audio_buffer.speech_started) לעצור דיבור של הבוט
        if (MB_ALLOW_BARGE_IN && evt.type === 'input_audio_buffer.speech_started') {
          try {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          } catch {}
          return;
        }

        // אם ה-AI סיים תגובה והוציא "closing" לפי הפרומפט, לא מנתקים פה בכוח;
        // Twilio יישאר מחובר, אז אנחנו נסגור אחרי grace כשTwilio יסגור/או לפי max.
      });

      openAiWs.on('close', () => {
        // לא סוגרים את Twilio מיד; נותנים grace קצר
        setTimeout(() => closeAll('openai_closed'), OUTBOUND_HANGUP_GRACE_MS);
      });

      openAiWs.on('error', (e) => {
        console.error('OpenAI WS error:', e?.message || e);
        setTimeout(() => closeAll('openai_error'), 200);
      });

      return;
    }

    if (data.event === 'media') {
      // Forward caller audio to OpenAI
      const payload = data.media?.payload;
      if (!payload) return;
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (data.event === 'stop') {
      // Twilio ended
      closeAll('twilio_stop');
      return;
    }
  });

  twilioWs.on('close', () => closeAll('twilio_closed'));
  twilioWs.on('error', () => closeAll('twilio_error'));

  function renderOpening(name) {
    const template = OUTBOUND_OPENING_SCRIPT || 'הַי… (הַפְסָקָה שֶׁל שְׁנִיָּה) הַאִם אֲנִי מְדַבֶּרֶת עִם ${FULL_NAME}?';
    const safeName = (name || '').trim();
    return template.replace(/\$\{FULL_NAME\}/g, safeName || '...');
  }

  function buildInstructions({ languages, opening, closing }) {
    // כאן אנחנו “מזריקים” את כל הפרומפטים שלך + חוק הסגירה והניתוק אחרי grace
    return `
אַתֶּם "נֶטָּע" — בּוֹט קוֹלִי שָׂמֵחַ, אֲמִתִּי וּמְכִירָתִי, בְּלָשׁוֹן רַבִּים.
זוֹ שִׂיחָה יוֹזֶמֶת (שִׂיחָה יוֹצֵאת).

שָׂפוֹת מוּתָּרוֹת: ${languages}.
בְּרִירַת מֶחְדָּל: עִבְרִית. אִם הָאָדָם עוֹנֶה בְּאַנְגְּלִית/רוּסִית/עֲרָבִית — תַּעַבְרוּ בִּטְבִיעוּת לְאוֹתָהּ שָׂפָה.

פְּתִיחַ הַשִּׂיחָה (כְּבָר נֶאֱמַר עַל־יָדֵיכֶם): 
"${opening}"

חוק זיהוי:
- אִם הָאָדָם אוֹמֵר "כֵּן" / "מְדַבֵּר" — ממשיכים.
- אִם "לֹא" / "טָעוּת" — מִתְנַצְּלִים קָצָר, שׁוֹאֲלִים אִם יֵשׁ לָנוּ לְמִי לְפְנוֹת, וּמְסַיְּמִים מִיָּד בְּנִימוּס.
- אִם לֹא בָּרוּר — שְׁאֵלַת הֶבְהֵר קְצָרָה אַחַת.

מַה לְהַצִּיג כְּשֶׁהוּא הַנָּכוֹן:
- "קוֹרְאִים לִי נֶטָּע, אֲנִי הַבּוֹט הַקּוֹלִי שֶׁל חֶבְרַת מִיסְטֶר בּוֹט, אָנוּ מַצִּיעִים פִּתְרוֹנוֹת מַעֲנֶה טֶלֶפוֹנִי לַעֲסָקִים בְּאֶמְצָעוּת בּוֹט כָּמוֹנִי."
- שְׁאֵלַת עִנְיָן: "הַאִם אֶפְשָׁר לְעַנְיֵן אֶתְכֶם בְּכָךְ לָעֵסֶק שֶׁלָּכֶם?"

מַטָּרָה:
- אִם יֵשׁ עִנְיָן: בִּירוּר צֹרֶךְ רִאשׁוֹנִי (סוּג עֵסֶק, נְפָח שִׂיחוֹת, כְּאֵבִים בְּמַעֲנֶה טֶלֶפוֹנִי, שֵׁרוּת/מִכִּירוֹת/תִּיאוּם תּוֹרִים/תִּזְכּוֹרוֹת/מוֹקֵד טֶכְנִי).
- לֹא מְדַבְּרִים עַל מְחִירִים — רַק מַסְבִּירִים מוֹדֶל תִּמְחוּר (דַּקּוֹת/שִׁימוּשׁ/חֲבִילָה) וְשֶׁנְּצִיג מְכִירוֹת חוֹזֵר עִם הַצָּעָה מְסֻדֶּרֶת.
- הִתְנַגְּדוּיוֹת: לְקַבֵּל בְּהֲבָנָה, לְתַת מִשְׁפָּט–שְׁנַיִם מַרְגִּיעִים וּמְדוּיָּקִים, וְלַחֲזוֹר לְשֵׁאֲלָה קְטַנָּה לְהַמְשָׁךְ. אִם לֹא רוֹצִים — לְכַבֵּד וּלְסַיֵּם.

מֵידָע עָלֵינוּ (אִם שׁוֹאֲלִים):
- כְּ־4 שָׁנִים בַּתְּחוּם, כּ־10 עוֹבְדִים.
- פּוֹעֲלִים עִם מִגְוָן עֲסָקִים וְאַרְגּוֹנִים בְּיִשְׂרָאֵל (לֹא מְצַיְּנִים שֵׁמוֹת).
- מְמוּקָּמִים בְּתֵל־אָבִיב, אֵזוֹר רָמַת הַחַיָּל.

הַפְּרוֹמְפְּט הַכְּלָלִי:
${OUTBOUND_GENERAL_PROMPT}

הַפְּרוֹמְפְּט הָעִסְקִי:
${OUTBOUND_BUSINESS_PROMPT}

סִגּוּר:
- כְּשֶׁמַּגִּיעִים לְסִיּוּם, אוֹמְרִים רַק אֶת מִשְׁפַּט הַסִּגּוּר הַמֻּגְדָּר (לְלֹא שְׁאֵלוֹת בַּסּוֹף):
"${closing}"
- אַחֲרֵי שֶׁאָמַרְתֶּם אֶת הַסִּגּוּר — מְסַיְּמִים.
`.trim();
  }

  // cleanup
  twilioWs.on('close', () => clearTimeout(maxTimer));
  twilioWs.on('error', () => clearTimeout(maxTimer));
});

// -----------------------------
// Start
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot OUTBOUND server listening on port ${PORT}`);
});
