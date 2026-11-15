// Shared by the functions in /api (Vercel Functions in production, and the
// dev middleware in vite.config.js locally).

export const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Optional gate for public deployments: when APP_PASSWORD is set, every API
// call must carry it, so strangers who find the URL cannot spend your API credits.
export function unauthorized(request) {
  const expected = process.env.APP_PASSWORD;
  if (!expected || request.headers.get("x-app-password") === expected) return null;
  return json(401, { error: "Wrong or missing app password" });
}

export const groqUrl = (path) => (process.env.GROQ_BASE_URL || "https://api.groq.com") + path;
export const deepgramUrl = (path) => (process.env.DEEPGRAM_BASE_URL || "https://api.deepgram.com") + path;

// Keeps the newest messages that fit a token budget and drops the oldest, so a
// long chat stays fast and never overflows the model's context window. Tokens
// are estimated at 3 characters each, which errs on the side of trimming early.
// The latest message is always kept, and the result always opens on a user turn.
export function trimHistory(messages, budget) {
  let used = 0;
  let start = messages.length;
  while (start > 0) {
    const cost = Math.ceil(messages[start - 1].content.length / 3) + 4;
    if (start < messages.length && used + cost > budget) break;
    used += cost;
    start--;
  }
  while (start < messages.length - 1 && messages[start].role !== "user") start++;
  return messages.slice(start);
}
