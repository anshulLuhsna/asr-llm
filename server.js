// Zero-dependency server: serves the UI, mints short-lived Deepgram tokens,
// and pipes Groq's streaming chat completions straight through to the browser.
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || "low";
const GROQ_BASE_URL = new URL(process.env.GROQ_BASE_URL || "https://api.groq.com");
const DEEPGRAM_BASE_URL = new URL(process.env.DEEPGRAM_BASE_URL || "https://api.deepgram.com");

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Keep-alive agents so a turn never pays for a fresh TCP + TLS handshake.
const agents = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};

function upstream(base, path, { method = "GET", headers = {}, body } = {}) {
  const lib = base.protocol === "http:" ? http : https;
  const req = lib.request({
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || undefined,
    path,
    method,
    agent: agents[base.protocol],
    headers: body ? { ...headers, "content-length": Buffer.byteLength(body) } : headers,
  });
  req.end(body);
  return req;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// POST https://api.deepgram.com/v1/auth/grant -> { access_token, expires_in }
// The browser opens its own WebSocket to Deepgram with this token, so audio
// never detours through this server and the API key never leaves it.
function handleToken(res) {
  if (!DEEPGRAM_API_KEY) return sendJson(res, 500, { error: "DEEPGRAM_API_KEY is not set on the server" });
  const up = upstream(DEEPGRAM_BASE_URL, "/v1/auth/grant", {
    method: "POST",
    headers: { authorization: `Token ${DEEPGRAM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  up.on("response", (r) => {
    const chunks = [];
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let data = {};
      try { data = JSON.parse(text); } catch {}
      if (r.statusCode !== 200 || !data.access_token) {
        return sendJson(res, 502, {
          error: `Deepgram token grant failed (${r.statusCode}): ${data.err_msg || text.slice(0, 200)}`,
        });
      }
      sendJson(res, 200, { access_token: data.access_token, expires_in: data.expires_in });
    });
  });
  up.on("error", (e) => sendJson(res, 502, { error: `Deepgram unreachable: ${e.message}` }));
}

// Opens (or reuses) the pooled connection to Groq so the next completion
// starts on a hot socket. Called by the browser when the user starts speaking.
function handleWarm(res) {
  res.writeHead(204).end();
  if (!GROQ_API_KEY) return;
  const up = upstream(GROQ_BASE_URL, "/openai/v1/models", {
    headers: { authorization: `Bearer ${GROQ_API_KEY}` },
  });
  up.on("response", (r) => r.resume());
  up.on("error", () => {});
}

async function handleChat(req, res) {
  if (!GROQ_API_KEY) return sendJson(res, 500, { error: "GROQ_API_KEY is not set on the server" });
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: `Bad request body: ${e.message}` });
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];
  if (!messages.length) return sendJson(res, 400, { error: "messages is required" });
  if (typeof payload.system === "string" && payload.system.trim()) {
    messages.unshift({ role: "system", content: payload.system });
  }

  const up = upstream(GROQ_BASE_URL, "/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      stream: true,
      reasoning_effort: GROQ_REASONING_EFFORT,
      include_reasoning: false,
    }),
  });
  // Browser aborted (speculative answer cancelled, new chat, ...) -> stop generating.
  res.on("close", () => up.destroy());
  up.on("response", (r) => {
    if (r.statusCode !== 200) {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let msg = text.slice(0, 300);
        try { msg = JSON.parse(text).error.message || msg; } catch {}
        sendJson(res, r.statusCode, { error: `Groq error (${r.statusCode}): ${msg}` });
      });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay(true);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (res.headersSent) res.end();
    else if (!res.destroyed) sendJson(res, 502, { error: `Groq unreachable: ${e.message}` });
  });
}

async function handleStatic(pathname, res) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname);
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
    if (req.method === "POST" && pathname === "/api/deepgram-token") return handleToken(res);
    if (req.method === "POST" && pathname === "/api/warm") return handleWarm(res);
    if (req.method === "GET") return handleStatic(pathname, res);
    sendJson(res, 405, { error: "Method not allowed" });
  })
  .listen(PORT, () => {
    console.log(`Voice chat running at http://localhost:${PORT}`);
    if (!DEEPGRAM_API_KEY) console.warn("  ! DEEPGRAM_API_KEY is missing");
    if (!GROQ_API_KEY) console.warn("  ! GROQ_API_KEY is missing");
  });
