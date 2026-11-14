import { groqUrl, unauthorized } from "../server/shared.js";

// Called when the user starts speaking: wakes this function instance and opens
// its connection to Groq, so the completion that follows skips the cold start
// and the TLS handshake.
export async function POST(request) {
  const denied = unauthorized(request);
  if (denied) return denied;
  const key = process.env.GROQ_API_KEY;
  if (key) {
    try {
      const r = await fetch(groqUrl("/openai/v1/models"), { headers: { authorization: `Bearer ${key}` } });
      await r.arrayBuffer();
    } catch {}
  }
  return new Response(null, { status: 204 });
}
