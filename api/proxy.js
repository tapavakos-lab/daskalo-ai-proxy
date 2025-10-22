// api/proxy.js
export const config = { runtime: 'edge' };

// --- ALLOW LIST (με ασφαλές fallback & debug) ---
const RAW = (process.env.CORS_ORIGIN || '').trim();
let ALLOWED = RAW
  .split(',')
  .map(s => s.trim().toLowerCase().replace(/\/+$/, ''))
  .filter(Boolean);

// Αν δεν υπάρχει ENV στη Edge, βάλε default τους δύο τομείς
if (ALLOWED.length === 0) {
  ALLOWED = ['https://www.kidai.gr', 'https://kidai.gr'];
}

function buildCorsHeaders(origin) {
  const norm = (origin || '').toLowerCase().replace(/\/+$/, '');
  const ok = ALLOWED.includes(norm);

  const h = new Headers({
    'Vary': 'Origin',
    'x-debug-raw': RAW || '(empty)',
    'x-debug-allowed': ALLOWED.join('|'),
    'x-debug-origin': origin || '(no-origin)'
  });

  if (ok) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    h.set('Access-Control-Max-Age', '86400');
  }
  return h;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const cors = buildCorsHeaders(origin);
  const hasACAO = cors.has('Access-Control-Allow-Origin');

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Μόνο επιτρεπτά origins
  if (!hasACAO) {
    return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
      status: 403,
      headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
    });
  }

  // Διαβάζουμε σώμα
  let prompt = '';
  try {
    const body = await req.json();
    prompt = (body && body.prompt) || '';
  } catch (_) {}
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'missing_prompt' }), {
      status: 400,
      headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'no_api_key' }), {
      status: 401,
      headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
    });
  }

  // Κλήση OpenAI
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('upstream_timeout'), 12000);

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: ctrl.signal
    });

    clearTimeout(to);
    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
    });
  } catch (err) {
    clearTimeout(to);
    const code = (err && err.name === 'AbortError') ? 'upstream_timeout' : 'proxy_failure';
    return new Response(JSON.stringify({ error: code }), {
      status: 504,
      headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
    });
  }
}
