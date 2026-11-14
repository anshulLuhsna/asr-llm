import { deepgramUrl, json, unauthorized } from "../server/shared.js";

// Mints a 60-second Deepgram token. The browser opens its own WebSocket to
// Deepgram with it, so audio never detours through this server and the API
// key never reaches the browser.
export async function POST(request) {
  const denied = unauthorized(request);
  if (denied) return denied;
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return json(500, { error: "DEEPGRAM_API_KEY is not set on the server" });
  try {
    const r = await fetch(deepgramUrl("/v1/auth/grant"), {
      method: "POST",
      headers: { authorization: `Token ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!r.ok || !data.access_token) {
      return json(502, { error: `Deepgram token grant failed (${r.status}): ${data.err_msg || text.slice(0, 200)}` });
    }
    return json(200, { access_token: data.access_token, expires_in: data.expires_in });
  } catch (e) {
    return json(502, { error: `Deepgram unreachable: ${e.message}` });
  }
}
