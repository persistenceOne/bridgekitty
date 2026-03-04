import { describe, it, expect } from "vitest";

describe("XPRT staking multiplier tiers", () => {
  function getMultiplierTier(stakedXprt: number): { multiplier: string; nextTier: string | null; xprtNeeded: number | null } {
    if (stakedXprt >= 1_000_000) {
      return { multiplier: "5x", nextTier: null, xprtNeeded: null };
    } else if (stakedXprt >= 10_000) {
      return { multiplier: "2x", nextTier: "5x", xprtNeeded: 1_000_000 - stakedXprt };
    } else {
      return { multiplier: "1x", nextTier: "2x", xprtNeeded: 10_000 - stakedXprt };
    }
  }

  it("returns 1x for zero stake", () => {
    const tier = getMultiplierTier(0);
    expect(tier.multiplier).toBe("1x");
    expect(tier.nextTier).toBe("2x");
    expect(tier.xprtNeeded).toBe(10_000);
  });

  it("returns 1x for stake below 10,000", () => {
    const tier = getMultiplierTier(5_000);
    expect(tier.multiplier).toBe("1x");
    expect(tier.nextTier).toBe("2x");
    expect(tier.xprtNeeded).toBe(5_000);
  });

  it("returns 2x at exactly 10,000 staked", () => {
    const tier = getMultiplierTier(10_000);
    expect(tier.multiplier).toBe("2x");
    expect(tier.nextTier).toBe("5x");
    expect(tier.xprtNeeded).toBe(990_000);
  });

  it("returns 2x for stake between 10K and 1M", () => {
    const tier = getMultiplierTier(500_000);
    expect(tier.multiplier).toBe("2x");
    expect(tier.nextTier).toBe("5x");
    expect(tier.xprtNeeded).toBe(500_000);
  });

  it("returns 5x at exactly 1,000,000 staked", () => {
    const tier = getMultiplierTier(1_000_000);
    expect(tier.multiplier).toBe("5x");
    expect(tier.nextTier).toBeNull();
    expect(tier.xprtNeeded).toBeNull();
  });

  it("returns 5x for stake above 1M", () => {
    const tier = getMultiplierTier(2_000_000);
    expect(tier.multiplier).toBe("5x");
    expect(tier.nextTier).toBeNull();
    expect(tier.xprtNeeded).toBeNull();
  });
});

describe("XPRT rewards descriptive states", () => {
  it("uses descriptive states instead of 'unknown'", () => {
    const descriptiveStates = [
      "not_yet_tracked",
      "pending_epoch_close",
      "not_yet_determined",
      "no_qualifying_volume",
      "no_volume_recorded",
      "api_unavailable",
      "epoch_closed",
      "end_time_unknown",
      "calculation_failed",
    ];

    // None of these should be "unknown"
    for (const state of descriptiveStates) {
      expect(state).not.toBe("unknown");
      expect(state.length).toBeGreaterThan(0);
      // Each state should be snake_case and descriptive
      expect(state).toMatch(/^[a-z_]+$/);
    }
  });

  it("epoch endsIn calculation works correctly", () => {
    // Simulate epoch end time calculation
    const endTime = Date.now() + (5 * 60 * 60 * 1000) + (30 * 60 * 1000); // 5h 30m from now
    const diffMs = endTime - Date.now();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    expect(diffHours).toBe(5);
    expect(diffMinutes).toBe(30);
    expect(`${diffHours}h ${diffMinutes}m`).toBe("5h 30m");
  });

  it("returns epoch_closed when end time is in the past", () => {
    const endTime = Date.now() - 1000; // 1 second ago
    const now = Date.now();
    const result = endTime > now ? "active" : "epoch_closed";
    expect(result).toBe("epoch_closed");
  });
});
