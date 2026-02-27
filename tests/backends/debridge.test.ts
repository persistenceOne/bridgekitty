import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeBridgeBackend } from "../../src/backends/debridge.js";
import type { QuoteParams } from "../../src/backends/types.js";

// Mock gas estimator so tests don't depend on RPC/price fallbacks
vi.mock("../../src/utils/gas-estimator.js", () => ({
  getGasUnits: () => 65_000,
  estimateGasCostUsd: async () => ({ costUsd: 0.05, usingFallbackPrices: false }),
}));

const validParams: QuoteParams = {
  fromChainId: 1,
  toChainId: 8453,
  fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "100000000",
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
};

describe("DeBridgeBackend", () => {
  let backend: DeBridgeBackend;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    backend = new DeBridgeBackend("0.1", "0xAffiliateAddress000000000000000000000000");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    expect(backend.name).toBe("debridge");
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

  it("returns null when no estimation in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("parses valid quote response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        estimation: {
          srcChainTokenIn: { symbol: "USDC", decimals: 6, amount: "100000000" },
          dstChainTokenOut: { symbol: "USDC", decimals: 6, amount: "99500000" },
          costsDetails: [
            { payload: { feeApproximateUsdValue: "0.25" } },
            { payload: { feeApproximateUsdValue: "0.10" } },
          ],
          estimatedFulfillmentDelay: 30,
        },
        order: { id: "test-order" },
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.backendName).toBe("debridge");
    expect(quote!.provider).toContain("deBridge");
    expect(quote!.outputAmountRaw).toBe("99500000");
    expect(quote!.estimatedFeeUsd).toBeCloseTo(0.35 + 0.05, 1); // protocol fee + gas
    expect(quote!.estimatedTimeSeconds).toBe(30);
  });

  it("handles missing costsDetails gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        estimation: {
          srcChainTokenIn: { symbol: "USDC" },
          dstChainTokenOut: { symbol: "USDC", decimals: 6, amount: "99000000" },
        },
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.estimatedFeeUsd).toBeCloseTo(0.05, 1); // only gas, no protocol fee
  });

  it("handles NaN in fee values", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        estimation: {
          srcChainTokenIn: { symbol: "USDC" },
          dstChainTokenOut: { symbol: "USDC", decimals: 6, amount: "99000000" },
          costsDetails: [
            { payload: { feeApproximateUsdValue: "notanumber" } },
          ],
        },
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.estimatedFeeUsd).toBeCloseTo(0.05, 1); // NaN filtered, only gas
  });
});
