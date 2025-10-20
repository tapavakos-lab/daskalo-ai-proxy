// redeploy touch
// api/proxy.js
export const config = { runtime: 'edge' };

// Διαβάζουμε allow-list από ENV
const ALLOWED = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim().toLowerCase().replace(/\/+$/, ''))
  .filter(Boolean);

function makeCorsHeaders(origin) {
  const norm = (origin || '').toLowerCase().replace(/\/+$/, '');
  if (ALLOWED.includes(norm)) {
    return new Headers({
      'Access-Control-Allow-Origin': origin,                 // echo ακριβές Origin
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400'
    });
  }
  return new Headers(); // άγνωστο origin -> χωρίς CORS headers
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const cors = makeCorsHeaders(origin);

  // 1) Preflight (OPTIONS)
  if (req.method === 'OPTIONS') {
    if (!cors.get('Access-Control-Allow-Origin')) {
      return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    return new Response(null, { status: 204, headers: cors });
  }

  // 2) Μπλοκάρουμε άγνωστα origins
  if (!cors.get('Access-Control-Allow-Origin')) {
    return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // 3) Διαβάζουμε το σώμα
  let prompt = '';
  try {
    const body = await req.json();
    prompt = (body && body.prompt) || '';
  } catch (_) {}
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'missing_prompt' }), {
      status: 400,
      headers: cors
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'no_api_key' }), {
      status: 401,
      headers: cors
    });
  }

  // 4) Κλήση προς OpenAI με timeout για να μην βλέπεις 504 από Vercel
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('upstream_timeout'), 12000);

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: prompt
      }),
      signal: ctrl.signal
    });

    clearTimeout(to);
    const text = await upstream.text();

    if (!upstream.ok) {
      return new Response(text || JSON.stringify({ error: 'upstream_error' }), {
        status: upstream.status,
        headers: new Headers({ ...Object.fromEntries(cors), 'Content-Type': 'application/json; charset=utf-8' })
      });
    }

    return new Response(text, {
      status: 200,
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
