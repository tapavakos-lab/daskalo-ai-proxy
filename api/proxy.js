// api/proxy.js

// Επιτρεπόμενες προελεύσεις (CORS) — βάλε το Blogspot domain σου στο Vercel (env CORS_ORIGIN)
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(req, res);

  // Προ-έλεγχος CORS
  if (req.method === "OPTIONS") return res.status(200).end();

  // Υγεία endpoint για γρήγορο έλεγχο
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, msg: "daskalo-ai-proxy live" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Μπορεί να έρθει stringified JSON από μερικά widgets
    let payload = req.body;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch {}
    }

    const { prompt, temperature = 0.2, max_tokens = 350 } = payload || {};
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // Timeout ασφαλείας
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature,
        max_tokens,
        messages: [
          { role: "system", content: "Είσαι βοηθός για εκπαιδευτικό Blogspot. Απαντάς απλά, καθαρά και σύντομα για παιδιά δημοτικού." },
          { role: "user", content: prompt }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json(data);
    }

    // Επιστρέφουμε καθαρό κείμενο + τα raw για debugging αν τα χρειαστούμε
    const text = data?.choices?.[0]?.message?.content ?? "";
    return res.status(200).json({ text, raw: data });
  } catch (err) {
    console.error("Proxy error:", err);
    const message = err?.name === "AbortError" ? "Upstream timeout" : "Internal Server Error";
    return res.status(500).json({ error: message });
  }
}
