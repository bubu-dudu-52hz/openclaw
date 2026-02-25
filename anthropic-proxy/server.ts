import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY environment variable is required");
}

const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
const PORT = Number(process.env.PORT) || 3000;

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const app = new Hono();

app.use(logger());

if (AUTH_ENABLED) {
  if (!PROXY_API_KEY) {
    throw new Error("PROXY_API_KEY is required when AUTH_ENABLED=true");
  }
  // Accept auth via: Authorization: Bearer <key> OR x-api-key: <key>
  app.use("/v1/*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const xApiKey = c.req.header("x-api-key");
    const token = bearer || xApiKey || "";

    if (!token || !safeCompare(token, PROXY_API_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}

app.get("/health", (c) => c.json({ status: "ok" }));

const HARDCODED_MODEL = "claude-opus-4-6";

app.all("/v1/*", async (c) => {
  const url = new URL(c.req.url);
  // Strip double /v1 prefix (e.g. /v1/v1/messages -> /v1/messages)
  const pathname = url.pathname.replace(/^\/v1\/v1\//, "/v1/");
  const target = `https://api.anthropic.com${pathname}${url.search}`;

  // Forward all client headers, then override auth
  const headers = new Headers(c.req.raw.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.set("x-api-key", ANTHROPIC_API_KEY);
  headers.set("anthropic-version", "2023-06-01");
  headers.set("host", "api.anthropic.com");

  // Override model in POST request bodies
  let body: BodyInit | undefined;
  if (c.req.method !== "GET" && c.req.raw.body) {
    const raw = await c.req.text();
    try {
      const json = JSON.parse(raw);
      if (json.model) {
        console.log(`[proxy] model override: ${json.model} -> ${HARDCODED_MODEL}`);
        const patched = { ...json, model: HARDCODED_MODEL };
        body = JSON.stringify(patched);
        headers.set("content-length", String(Buffer.byteLength(body)));
      } else {
        body = raw;
      }
    } catch {
      body = raw;
    }
  }

  console.log(`[proxy] ${c.req.method} ${url.pathname} -> ${target}`);

  const res = await fetch(target, {
    method: c.req.method,
    headers,
    body,
  });

  // Log errors with response body for debugging
  if (!res.ok) {
    const body = await res.clone().text();
    console.log(`[proxy] <- ${res.status} ${body}`);
  } else {
    console.log(`[proxy] <- ${res.status} ${res.headers.get("content-type")}`);
  }

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`Anthropic proxy listening on http://localhost:${server.port}`);
if (AUTH_ENABLED) {
  console.log("Auth enabled — accepts Authorization: Bearer or x-api-key header");
}

function gracefulShutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
