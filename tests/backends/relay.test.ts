import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayBackend } from "../../src/backends/relay.js";
import type { QuoteParams } from "../../src/backends/types.js";

const validParams: QuoteParams = {
  fromChainId: 1,
  toChainId: 8453,
  fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "100000000",
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
};

describe("RelayBackend", () => {
  let backend: RelayBackend;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    backend = new RelayBackend("0xReferrer0000000000000000000000000000000", "10");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    expect(backend.name).toBe("relay");
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

  it("returns null when no steps in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ steps: [] }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("parses valid quote response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        steps: [
          {
            id: "bridge",
            items: [
              {
                data: {
                  to: "0xBridgeContract",
                  data: "0xCalldata",
                  value: "0",
                  chainId: 1,
                },
              },
            ],
          },
        ],
        details: {
          currencyIn: { currency: { symbol: "USDC", decimals: 6 }, amount: "100000000" },
          currencyOut: { currency: { symbol: "USDC", decimals: 6 }, amount: "99800000" },
          totalFee: { usd: "0.20" },
          timeEstimate: 30,
        },
        requestId: "test-req-123",
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.backendName).toBe("relay");
    expect(quote!.provider).toContain("Relay");
    expect(quote!.outputAmountRaw).toBe("99800000");
    expect(quote!.estimatedFeeUsd).toBeCloseTo(0.2, 1);
    expect(quote!.estimatedTimeSeconds).toBe(30);
  });

  it("handles missing details gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        steps: [
          {
            id: "bridge",
            items: [{ data: { to: "0x1", data: "0x2", value: "0" } }],
          },
        ],
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    // defaults should be used
    expect(quote!.outputAmountRaw).toBe("0");
    expect(quote!.estimatedTimeSeconds).toBe(60);
  });
});
