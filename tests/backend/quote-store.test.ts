import { describe, it, expect, beforeEach } from "vitest";
import { QuoteStore } from "../../backend/src/services/quote-store.js";
import type { CachedQuote } from "../../src/routing/engine.js";
import type { QuoteParams } from "../../src/backends/types.js";

function makeQuote(id: string, expiresAt = Date.now() + 60_000): CachedQuote {
  return {
    quoteId: id,
    backendName: "lifi",
    provider: "Stargate via LI.FI",
    outputAmount: "1000",
    outputAmountRaw: "1000000",
    minOutputAmount: "995",
    minOutputAmountRaw: "995000",
    estimatedGasCostUsd: 2.5,
    estimatedFeeUsd: 0.5,
    feeBreakdown: {
      gasCostUsd: 2.5,
      protocolFeeUsd: 0.5,
      integratorFeeUsd: 0,
      integratorFeePercent: null,
      totalFeeUsd: 3,
    },
    estimatedTimeSeconds: 60,
    route: "Ethereum → Arbitrum",
    quoteData: {},
    expiresAt,
  };
}

const baseParams: QuoteParams = {
  fromChainId: 1,
  toChainId: 42161,
  fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  amountRaw: "1000000",
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
};

describe("QuoteStore", () => {
  let store: QuoteStore;
  const TTL = 300_000; // 5 min

  beforeEach(() => {
    store = new QuoteStore(TTL);
  });

  it("stores and retrieves a quote by ID", () => {
    const quote = makeQuote("q1");
    store.put([quote], baseParams);

    const result = store.get("q1");
    expect(result).not.toBeNull();
    expect(result!.quoteId).toBe("q1");
    expect(result!.quote.provider).toBe("Stargate via LI.FI");
  });

  it("returns null for unknown IDs", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("returns null when TTL has elapsed", () => {
    const store2 = new QuoteStore(1); // 1ms TTL
    const quote = makeQuote("q2");
    store2.put([quote], baseParams);

    // Wait for TTL to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store2.get("q2")).toBeNull();
        resolve();
      }, 10);
    });
  });

  it("getWithExpiry returns expired=true for TTL-expired entry", () => {
    const store3 = new QuoteStore(1); // 1ms TTL
    const quote = makeQuote("q3");
    store3.put([quote], baseParams);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = store3.getWithExpiry("q3");
        expect(result).not.toBeNull();
        expect(result!.expired).toBe(true);
        resolve();
      }, 10);
    });
  });

  it("getWithExpiry returns expired=false for valid entry", () => {
    const quote = makeQuote("q4");
    store.put([quote], baseParams);
    const result = store.getWithExpiry("q4");
    expect(result).not.toBeNull();
    expect(result!.expired).toBe(false);
  });

  it("stores multiple quotes and retrieves each", () => {
    const quotes = [makeQuote("a"), makeQuote("b"), makeQuote("c")];
    store.put(quotes, baseParams);

    expect(store.get("a")).not.toBeNull();
    expect(store.get("b")).not.toBeNull();
    expect(store.get("c")).not.toBeNull();
    expect(store.size).toBe(3);
  });

  it("evict() removes expired entries", () => {
    const store4 = new QuoteStore(1);
    const quotes = [makeQuote("e1"), makeQuote("e2")];
    store4.put(quotes, baseParams);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        store4.evict();
        expect(store4.size).toBe(0);
        resolve();
      }, 10);
    });
  });

  it("preserves params for auto-refresh", () => {
    const quote = makeQuote("q5");
    store.put([quote], baseParams);
    const result = store.get("q5");
    expect(result!.params.fromChainId).toBe(1);
    expect(result!.params.toChainId).toBe(42161);
  });
});
