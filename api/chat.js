import { groqUrl, json, unauthorized } from "../server/shared.js";

// Streams a Groq chat completion back to the browser as server-sent events.
// Low-latency setup: stream=true, minimal reasoning with the reasoning text left
// out of the stream, the fastest service tier the account has, and Groq's SSE
// body handed through untouched (no parsing or re-encoding on the way).
export async function POST(request) {
  const denied = unauthorized(request);
  if (denied) return denied;
  const key = process.env.GROQ_API_KEY;
  if (!key) return json(500, { error: "GROQ_API_KEY is not set on the server" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Request body must be JSON" });
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];
  if (!messages.length) return json(400, { error: "messages is required" });
  if (typeof payload.system === "string" && payload.system.trim()) {
    messages.unshift({ role: "system", content: payload.system });
  }

  let upstream;
  try {
    upstream = await fetch(groqUrl("/openai/v1/chat/completions"), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        messages,
        stream: true,
        reasoning_effort: process.env.GROQ_REASONING_EFFORT || "low",
        include_reasoning: false,
        service_tier: process.env.GROQ_SERVICE_TIER || "auto",
      }),
      // Browser cancelled (speculative answer dropped, new chat, ...) -> stop generating.
      signal: request.signal,
    });
  } catch (e) {
    return json(502, { error: `Groq unreachable: ${e.message}` });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error.message || msg; } catch {}
    return json(upstream.status, { error: `Groq error (${upstream.status}): ${msg}` });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
