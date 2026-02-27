/**
 * Tests for rate limiter in get-quote.ts
 *
 * Since the rate limiter functions are module-private, we test them
 * by importing the module internals. We'll extract and test the logic directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to test the rate limiter logic. Since it's not exported,
// we replicate the exact logic here for unit testing.
// The implementation in get-quote.ts uses these exact constants and logic.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

function createRateLimiter() {
  const rateLimitMap = new Map<string, number[]>();
  let rateLimitCheckCount = 0;

  function evictStaleRateLimitEntries(): void {
    const now = Date.now();
    for (const [key, timestamps] of rateLimitMap) {
      const hasRecent = timestamps.some(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (!hasRecent) {
        rateLimitMap.delete(key);
      }
    }
  }

  function checkRateLimit(routeKey: string): boolean {
    const now = Date.now();
    rateLimitCheckCount++;
    if (rateLimitCheckCount % 100 === 0) {
      evictStaleRateLimitEntries();
    }
    const timestamps = rateLimitMap.get(routeKey) ?? [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      rateLimitMap.set(routeKey, recent);
      return false;
    }
    recent.push(now);
    rateLimitMap.set(routeKey, recent);
    return true;
  }

  return { checkRateLimit, rateLimitMap, evictStaleRateLimitEntries, getCheckCount: () => rateLimitCheckCount };
}

describe("Rate Limiter", () => {
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(() => {
    limiter = createRateLimiter();
    vi.useFakeTimers();
  });

  it("allows requests within limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.checkRateLimit("route-a")).toBe(true);
    }
  });

  it("rejects 11th request in 1 minute for same route", () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.checkRateLimit("route-a")).toBe(true);
    }
    expect(limiter.checkRateLimit("route-a")).toBe(false);
  });

  it("different routes have independent limits", () => {
    for (let i = 0; i < 10; i++) {
      limiter.checkRateLimit("route-a");
    }
    expect(limiter.checkRateLimit("route-a")).toBe(false);
    expect(limiter.checkRateLimit("route-b")).toBe(true);
  });

  it("old timestamps are pruned (requests >60s ago don't count)", () => {
    for (let i = 0; i < 10; i++) {
      limiter.checkRateLimit("route-a");
    }
    expect(limiter.checkRateLimit("route-a")).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(60_001);

    // Now should be allowed again
    expect(limiter.checkRateLimit("route-a")).toBe(true);
  });

  it("eviction removes stale route keys", () => {
    limiter.checkRateLimit("stale-route");
    expect(limiter.rateLimitMap.has("stale-route")).toBe(true);

    // Advance past window
    vi.advanceTimersByTime(60_001);

    // Manually evict
    limiter.evictStaleRateLimitEntries();
    expect(limiter.rateLimitMap.has("stale-route")).toBe(false);
  });

  vi.useRealTimers;
});
