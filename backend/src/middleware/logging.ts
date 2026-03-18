import type { Context, Next } from "hono";

/**
 * Request/response logging middleware. Emits JSON to stderr.
 */
export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  await next();

  const durationMs = Date.now() - start;
  const status = c.res.status;

  process.stderr.write(
    JSON.stringify({ type: "request", method, path, status, ip, durationMs }) + "\n"
  );
}
