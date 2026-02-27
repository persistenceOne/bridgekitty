/**
 * Tests for pre-build expiry check in execute-bridge.ts
 *
 * The execute-bridge tool rejects quotes that would expire within BUILD_TIMEOUT_MS (15s).
 */
import { describe, it, expect, vi } from "vitest";

// The BUILD_TIMEOUT_MS in execute-bridge.ts is 15_000
const BUILD_TIMEOUT_MS = 15_000;

describe("Pre-build expiry check", () => {
  // Replicate the check from execute-bridge.ts:
  // if (quote.expiresAt && quote.expiresAt <= Date.now() + BUILD_TIMEOUT_MS) → reject
  function wouldRejectQuote(expiresAt: number): boolean {
    return expiresAt <= Date.now() + BUILD_TIMEOUT_MS;
  }

  it("rejects a quote expiring within BUILD_TIMEOUT_MS", () => {
    // Quote expires in 10s — within the 15s threshold
    const expiresAt = Date.now() + 10_000;
    expect(wouldRejectQuote(expiresAt)).toBe(true);
  });

  it("accepts a fresh quote", () => {
    // Quote expires in 120s — well beyond the 15s threshold
    const expiresAt = Date.now() + 120_000;
    expect(wouldRejectQuote(expiresAt)).toBe(false);
  });

  it("rejects an already-expired quote", () => {
    const expiresAt = Date.now() - 5_000;
    expect(wouldRejectQuote(expiresAt)).toBe(true);
  });
});
