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
