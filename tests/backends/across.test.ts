import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AcrossBackend } from "../../src/backends/across.js";
import type { QuoteParams } from "../../src/backends/types.js";

const validParams: QuoteParams = {
  fromChainId: 1,
  toChainId: 8453,
  fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // same token for Across
  amountRaw: "100000000",
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
  fromTokenDecimals: 6,
};

describe("AcrossBackend", () => {
  let backend: AcrossBackend;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    backend = new AcrossBackend("0xReferrer0000000000000000000000000000000");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    expect(backend.name).toBe("across");
  });

  it("returns null for cross-token swaps (different symbols)", async () => {
    const crossTokenParams: QuoteParams = {
      ...validParams,
      // USDC on Ethereum → USDT on Base (different symbols)
      toTokenAddress: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      toChainId: 8453,
    };

    const quote = await backend.getQuote(crossTokenParams);
    expect(quote).toBeNull();
  });

  it("allows same-symbol tokens with different addresses across chains (e.g. USDC)", async () => {
    // USDC on Ethereum (0xA0b8...) → USDC on Base (0x8335...)
    // These have different addresses but same symbol — Across should handle this
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalRelayFee: { total: "500000" },
        estimatedFillTimeSec: 15,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });

    const crossChainUsdcParams: QuoteParams = {
      ...validParams,
      fromChainId: 1,
      toChainId: 8453,
      fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on Ethereum
      toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // USDC on Base
    };

    const quote = await backend.getQuote(crossChainUsdcParams);
    expect(quote).not.toBeNull();
    expect(quote!.backendName).toBe("across");
  });

  it("returns null for unknown token addresses with different values", async () => {
    // Two unknown addresses that aren't in the registry
    const unknownParams: QuoteParams = {
      ...validParams,
      fromTokenAddress: "0x1111111111111111111111111111111111111111",
      toTokenAddress: "0x2222222222222222222222222222222222222222",
    };

    const quote = await backend.getQuote(unknownParams);
    expect(quote).toBeNull();
  });

  it("returns null on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "error",
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("returns null when fee exceeds input amount", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalRelayFee: { total: "200000000" }, // fee > input
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("parses valid quote response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalRelayFee: { total: "500000" }, // 0.5 USDC
        estimatedFillTimeSec: 15,
        timestamp: Math.floor(Date.now() / 1000),
        exclusiveRelayer: "0x0000000000000000000000000000000000000000",
        exclusivityDeadline: 0,
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.backendName).toBe("across");
    expect(quote!.provider).toContain("Across");
    expect(quote!.outputAmountRaw).toBe("99500000"); // 100M - 500K
    expect(quote!.estimatedTimeSeconds).toBe(15);
    expect(quote!.feeBreakdown.totalFeeUsd).toBeGreaterThan(0);
  });

  it("returns null when totalRelayFee is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("stores spokePool in quoteData", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalRelayFee: { total: "500000" },
        estimatedFillTimeSec: 15,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    const qd = quote!.quoteData as any;
    expect(qd.spokePool).toBeDefined();
  });
});
