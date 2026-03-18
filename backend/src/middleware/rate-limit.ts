import type { Context, Next } from "hono";

interface RateLimitEntry {
  timestamps: number[];
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(key: string): Map<string, RateLimitEntry> {
  let store = stores.get(key);
  if (!store) {
    store = new Map();
    stores.set(key, store);
  }
  return store;
}

/**
 * Create a per-IP rate limiter middleware.
 *
 * @param maxRequests - maximum requests allowed within the window
 * @param windowMs - sliding window duration in milliseconds
 * @param storeKey - namespace to keep different limiters separate
 */
export function rateLimit(maxRequests: number, windowMs: number, storeKey: string) {
  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const store = getStore(storeKey);
    const now = Date.now();
    const entry = store.get(ip) ?? { timestamps: [] };

    // Prune timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      store.set(ip, entry);
      return c.json(
        { error: "Rate limit exceeded. Please slow down.", retryAfter: Math.ceil(windowMs / 1000) },
        429
      );
    }

    entry.timestamps.push(now);
    store.set(ip, entry);
    await next();
  };
}
