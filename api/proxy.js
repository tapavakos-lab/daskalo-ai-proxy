// /api/proxy.js — Daskalo AI Proxy (Vercel Serverless)

// --- Απλό rate limit ανά IP (3 αιτήματα / 10s)
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

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = 'https://diadrastika-dimotiko.blogspot.com';

  // ---- CORS
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ---- Rate limit
  const ip =
    (req.headers['x-forwarded-for']?.split(',')[0] || '').trim() ||
    req.connection?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Περίμενε λίγο.' });
  }

  // ---- Ασφαλές parse σώματος (παίζει σε όλες τις διαμορφώσεις Vercel)
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
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { messages, meta } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Bad request — messages[] required.' });
  }

  // ---- Επιλογή μοντέλου (απλή λογική, μπορείς να αλλάξεις)
  const model =
    meta?.activity === 'summary' ? 'gpt-4o-mini'
    : meta?.activity === 'exercise' ? 'gpt-4o-mini'
    : 'gpt-4o-mini';

  try {
    // ---- Κλήση OpenAI
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: 'LLM error', detail });
    }

    const json = await r.json();
    const reply = json.choices?.[0]?.message?.content || '—';
    return res.status(200).json({ ok: true, reply });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
