// /api/proxy.js  — Daskalo AI Proxy
// Λειτουργεί με Vercel serverless και προστατεύει το OpenAI API key

// --- Απλό rate limit ανά IP (3 αιτήματα / 10 δευτερόλεπτα)
const recentCalls = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 1000; // 10 δευτερόλεπτα
  const limit = 3; // όριο αιτημάτων

  const calls = recentCalls.get(ip) || [];
  const recent = calls.filter(ts => now - ts < windowMs);
  recent.push(now);
  recentCalls.set(ip, recent);
  return recent.length > limit;
}

export default async function handler(req, res) {
  // --- CORS μόνο για το blog σου (όχι *)
  res.setHeader('Access-Control-Allow-Origin', 'https://diadrastika-dimotiko.blogspot.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- Rate limit
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Περίμενε λίγο πριν ξαναστείλεις.' });
  }

  try {
    const { messages, meta } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Bad request — messages array missing.' });
    }

    // --- Επιλογή μοντέλου
    const model =
      meta?.activity === 'summary'
        ? 'gpt-4o-mini'
        : meta?.activity === 'exercise'
        ? 'gpt-4o-mini'
        : 'gpt-4o-mini';

    // --- Κλήση OpenAI API
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
      const txt = await r.text();
      return res.status(500).json({ error: 'LLM error', detail: txt });
    }

    const json = await r.json();
    const reply = json.choices?.[0]?.message?.content || '—';
    return res.status(200).json({ reply, ok: true });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
