import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker } from "../../src/utils/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      failureWindowMs: 60_000,
      cooldownMs: 5_000,
      extendedCooldownMs: 10_000,
    });
  });

  it("allows requests by default", () => {
    expect(cb.isAllowed("test")).toBe(true);
    expect(cb.getState("test")).toBe("CLOSED");
  });

  it("stays CLOSED with fewer failures than threshold", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    expect(cb.isAllowed("test")).toBe(true);
    expect(cb.getState("test")).toBe("CLOSED");
  });

  it("opens circuit after threshold failures", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test"); // 3rd failure = threshold
    expect(cb.getState("test")).toBe("OPEN");
    expect(cb.isAllowed("test")).toBe(false);
  });

  it("transitions to HALF_OPEN after cooldown", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    expect(cb.getState("test")).toBe("OPEN");

    // Advance past cooldown
    vi.useFakeTimers();
    vi.advanceTimersByTime(5_001);

    expect(cb.getState("test")).toBe("HALF_OPEN");
    expect(cb.isAllowed("test")).toBe(true);

    vi.useRealTimers();
  });

  it("closes circuit on success in HALF_OPEN", () => {
    vi.useFakeTimers();

    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");

    vi.advanceTimersByTime(5_001);
    expect(cb.getState("test")).toBe("HALF_OPEN");

    cb.recordSuccess("test");
    expect(cb.getState("test")).toBe("CLOSED");
    expect(cb.isAllowed("test")).toBe(true);

    vi.useRealTimers();
  });

  it("re-opens circuit with extended cooldown on HALF_OPEN failure", () => {
    vi.useFakeTimers();

    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");

    // Wait for cooldown to transition to HALF_OPEN
    vi.advanceTimersByTime(5_001);
    expect(cb.getState("test")).toBe("HALF_OPEN");

    // Fail in HALF_OPEN → OPEN with extended cooldown
    cb.recordFailure("test");
    expect(cb.getState("test")).toBe("OPEN");
    expect(cb.isAllowed("test")).toBe(false);

    // Standard cooldown (5s) should not be enough
    vi.advanceTimersByTime(5_001);
    expect(cb.getState("test")).toBe("OPEN"); // still open

    // Extended cooldown (10s) should work
    vi.advanceTimersByTime(5_000);
    expect(cb.getState("test")).toBe("HALF_OPEN");

    vi.useRealTimers();
  });

  it("tracks multiple backends independently", () => {
    cb.recordFailure("backend-a");
    cb.recordFailure("backend-a");
    cb.recordFailure("backend-a");

    expect(cb.getState("backend-a")).toBe("OPEN");
    expect(cb.getState("backend-b")).toBe("CLOSED");
    expect(cb.isAllowed("backend-b")).toBe(true);
  });

  it("resets a specific backend", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    expect(cb.getState("test")).toBe("OPEN");

    cb.reset("test");
    expect(cb.getState("test")).toBe("CLOSED");
    expect(cb.isAllowed("test")).toBe(true);
  });

  it("resets all backends", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("b");
    cb.recordFailure("b");
    cb.recordFailure("b");

    cb.resetAll();
    expect(cb.getState("a")).toBe("CLOSED");
    expect(cb.getState("b")).toBe("CLOSED");
  });

  it("reports all circuit states", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a");

    const states = cb.getAll();
    expect(states.a).toBe("OPEN");
  });

  it("success gradually reduces failure count", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    // 2 failures, one success removes the oldest → 1 failure left
    cb.recordSuccess("test");
    cb.recordFailure("test"); // now 2 failures
    cb.recordFailure("test"); // now 3 failures = threshold
    expect(cb.getState("test")).toBe("OPEN");
  });

  // ─── Half-Open Lock Tests (V3-LOW-001) ─────────────────────────────

  it("in HALF_OPEN state, first isAllowed() returns true", () => {
    vi.useFakeTimers();
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    vi.advanceTimersByTime(5_001);
    expect(cb.getState("test")).toBe("HALF_OPEN");
    expect(cb.isAllowed("test")).toBe(true);
    vi.useRealTimers();
  });

  it("second concurrent isAllowed() in HALF_OPEN returns false", () => {
    vi.useFakeTimers();
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    vi.advanceTimersByTime(5_001);
    expect(cb.isAllowed("test")).toBe(true); // first caller gets through
    expect(cb.isAllowed("test")).toBe(false); // second caller blocked
    vi.useRealTimers();
  });

  it("half-open lock is released after recordSuccess()", () => {
    vi.useFakeTimers();
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    vi.advanceTimersByTime(5_001);
    cb.isAllowed("test"); // acquires lock
    cb.recordSuccess("test"); // releases lock, goes to CLOSED

    // Now should be CLOSED and freely allowed
    expect(cb.getState("test")).toBe("CLOSED");
    expect(cb.isAllowed("test")).toBe(true);
    vi.useRealTimers();
  });

  it("half-open lock is released after recordFailure()", () => {
    vi.useFakeTimers();
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    vi.advanceTimersByTime(5_001);
    cb.isAllowed("test"); // acquires lock
    cb.recordFailure("test"); // releases lock, goes to OPEN

    expect(cb.getState("test")).toBe("OPEN");
    // After extended cooldown, should be HALF_OPEN again and lock should be available
    vi.advanceTimersByTime(10_001);
    expect(cb.getState("test")).toBe("HALF_OPEN");
    expect(cb.isAllowed("test")).toBe(true); // lock was released
    vi.useRealTimers();
  });

  it("multiple successes fully drain failures", () => {
    cb.recordFailure("test");
    cb.recordFailure("test");
    // Two successes remove both failures one by one
    cb.recordSuccess("test"); // 1 failure left
    cb.recordSuccess("test"); // 0 failures left
    cb.recordFailure("test"); // 1 failure
    cb.recordFailure("test"); // 2 failures, below threshold
    expect(cb.getState("test")).toBe("CLOSED");
  });
});
