// /api/proxy.js — Daskalo AI Proxy (Vercel)
// Δέχεται:
//  A) { prompt, recaptchaToken?, temperature?, max_tokens?, meta? }
//  B) { messages: [...], meta? }
// Περιλαμβάνει: CORS από ENV (kidai.gr), απλό rate-limit, (προαιρετικό) reCAPTCHA

/* ========================= CORS ========================= */
/** Περιμένει ENV CORS_ORIGIN π.χ. "https://www.kidai.gr,https://kidai.gr" */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'https://www.kidai.gr,https://kidai.gr')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function getOriginFromReq(req) {
  // Σε Vercel (Node), τα headers είναι object. Δεν υπάρχει headers.get.
  const h = req?.headers || {};
  const origin = h.origin || h.Origin || '';
  if (origin) return origin;
  // fallback: πήγαινε από το referer (αν υπάρχει) και πάρε το origin
  try {
    const ref = h.referer || h.Referer || '';
    if (ref) return new URL(ref).origin;
  } catch {}
  return '';
}

function pickCorsOrigin(req) {
  const origin = getOriginFromReq(req);
  return ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');
}

/* ====================== Rate Limiting ==================== */
// 3 αιτήματα / 10s ανά IP (απλό in-memory — αρκεί για hobby)
const recentCalls = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 1000;
  const limit = 3;
  const list = recentCalls.get(ip) || [];
  const fresh = list.filter(ts => now - ts < windowMs);
  fresh.push(now);
  recentCalls.set(ip, fresh);
  return fresh.length > limit;
}

/* =================== System prompt builder =================== */
function buildSystem(meta = {}) {
  const role = meta.role || 'child';
  const grade = meta.grade || 'A';
  const activity = meta.activity || 'explain';
  const bits = [
    'Μιλάς ελληνικά, είσαι παιδαγωγικός βοηθός.',
    role === 'parent'
      ? 'Απευθύνεσαι σε γονέα με σαφείς πρακτικές οδηγίες.'
      : 'Απευθύνεσαι σε παιδί: μικρά βήματα, απλά παραδείγματα.',
    grade ? `Τάξη: ${grade}.` : '',
    activity === 'exercise' ? 'Δώσε άσκηση. Αν δεν ζητηθεί λύση, απόκρυψέ την.' : '',
    activity === 'summary' ? 'Σύντομη περίληψη με bullets.' : '',
    'Απόφυγε προσωπικά δεδομένα.'
  ].filter(Boolean);
  return bits.join(' ');
}

/* ================= reCAPTCHA (προαιρετικό) ================= */
async function verifyRecaptchaIfConfigured(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!token || !secret) return { ok: true }; // δεν ελέγχουμε αν δεν έχει ρυθμιστεί
  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
    });
    const json = await r.json();
    return { ok: !!json.success, detail: json };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/* ======================= Handler ======================== */
export default async function handler(req, res) {
  // --- CORS headers (δυναμικά από ENV)
  const corsOrigin = pickCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  // --- Rate limit
  const ip =
    (req.headers['x-forwarded-for']?.split(',')[0] || '').trim() ||
    req.connection?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Περίμενε λίγο.' });
  }

  // --- Safe body parse (μπορεί να έρθει string ή object)
  let body = {};
  try {
    if (req.body && Object.keys(req.body).length) {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } else {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      body = JSON.parse(raw);
    }
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // --- Υποστήριξη και για prompt ΚΑΙ για messages[]
  let { messages, meta, prompt, recaptchaToken, temperature, max_tokens } = body;

  if ((!Array.isArray(messages) || messages.length === 0) && typeof prompt === 'string') {
    const sys = buildSystem(meta);
    messages = [
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ];
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Bad request — messages[] required.' });
  }

  // (προαιρετικό) reCAPTCHA
  const recap = await verifyRecaptchaIfConfigured(recaptchaToken);
  if (!recap.ok) {
    return res.status(400).json({ error: 'reCAPTCHA failed', detail: recap.detail });
  }

  // Μοντέλο (μπορείς να αλλάξεις όποτε θέλεις)
  const model =
    meta?.activity === 'summary' ? 'gpt-4o-mini'
    : meta?.activity === 'exercise' ? 'gpt-4o-mini'
    : 'gpt-4o-mini';

  try {
    // Κλήση OpenAI
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: typeof temperature === 'number' ? temperature : 0.5,
        max_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
        messages
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: 'LLM error', detail });
    }

    const json = await r.json();
    const reply = json.choices?.[0]?.message?.content || '—';
    return res.status(200).json({
      ok: true,
      reply,
      // Σε production κρύβουμε το raw για ασφάλεια
      raw: process.env.NODE_ENV === 'development' ? json : undefined
    });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
