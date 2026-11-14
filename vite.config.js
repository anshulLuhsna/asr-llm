import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { defineConfig, loadEnv } from "vite";

// Runs the Vercel-style functions in /api inside `vite` and `vite preview`,
// so local development needs nothing but `npm run dev`.
function apiFunctions() {
  const mount = (server) => {
    server.middlewares.use(async (req, res, next) => {
      const { pathname } = new URL(req.url, "http://localhost");
      const name = pathname.match(/^\/api\/([\w-]+)$/)?.[1];
      const file = name && resolve("api", `${name}.js`);
      if (!file || !existsSync(file)) return next();
      try {
        const handler = (await import(pathToFileURL(file).href))[req.method];
        if (!handler) return res.writeHead(405).end();
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const response = await handler(
          new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
            signal: abort.signal,
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return res.end();
        res.socket?.setNoDelay(true);
        Readable.fromWeb(response.body).on("error", () => res.end()).pipe(res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  };
  return { name: "api-functions", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  // Make .env / .env.local visible to the API functions (real env vars win).
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ""))) process.env[k] ??= v;
  return { plugins: [apiFunctions()] };
});
