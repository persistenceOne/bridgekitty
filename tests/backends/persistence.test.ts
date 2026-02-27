import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import { BackendValidationError } from "../../src/backends/types.js";
import type { QuoteParams } from "../../src/backends/types.js";

// Valid params for Persistence (BTC on Base → BSC)
const validParams: QuoteParams = {
  fromChainId: 8453,
  toChainId: 56,
  fromTokenAddress: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC on Base
  toTokenAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", // BTCB on BSC
  amountRaw: "10000", // 0.0001 BTC (within caps)
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
};

describe("PersistenceBackend", () => {
  let backend: PersistenceBackend;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    backend = new PersistenceBackend();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    expect(backend.name).toBe("persistence");
  });

  it("returns null for unsupported chains", async () => {
    const params: QuoteParams = {
      ...validParams,
      fromChainId: 1, // Ethereum — not supported
    };

    const quote = await backend.getQuote(params);
    expect(quote).toBeNull();
  });

  it("returns null for unsupported tokens", async () => {
    const params: QuoteParams = {
      ...validParams,
      fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC, not BTC
    };

    const quote = await backend.getQuote(params);
    expect(quote).toBeNull();
  });

  it("throws BackendValidationError for amount below minimum", async () => {
    const params: QuoteParams = { ...validParams, amountRaw: "100" }; // below 5000

    await expect(backend.getQuote(params)).rejects.toThrow(BackendValidationError);
    await expect(backend.getQuote(params)).rejects.toThrow(/too small/);
  });

  it("throws BackendValidationError for amount above maximum", async () => {
    const params: QuoteParams = { ...validParams, amountRaw: "999999999" }; // above 100000

    await expect(backend.getQuote(params)).rejects.toThrow(BackendValidationError);
    await expect(backend.getQuote(params)).rejects.toThrow(/too large/);
  });

  it("throws BackendValidationError for zero amount", async () => {
    const params: QuoteParams = { ...validParams, amountRaw: "0" };

    await expect(backend.getQuote(params)).rejects.toThrow(BackendValidationError);
    await expect(backend.getQuote(params)).rejects.toThrow(/positive/);
  });

  it("parses valid quote response", async () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [
          {
            estimatedDestinationAmount: "9900",
            expirationTime: future,
            orderId: "test-order-1",
          },
        ],
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.backendName).toBe("persistence");
    expect(quote!.provider).toContain("Persistence");
    expect(quote!.outputAmountRaw).toBe("9900");
    expect(quote!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("filters expired quotes from solver", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [
          { estimatedDestinationAmount: "9900", expirationTime: past },
          { estimatedDestinationAmount: "9800", expirationTime: past },
        ],
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull(); // all expired
  });

  it("picks best quote when multiple valid", async () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [
          { estimatedDestinationAmount: "9500", expirationTime: future },
          { estimatedDestinationAmount: "9900", expirationTime: future }, // best
          { estimatedDestinationAmount: "9700", expirationTime: future },
        ],
      }),
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).not.toBeNull();
    expect(quote!.outputAmountRaw).toBe("9900"); // best output
  });

  it("returns null on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const quote = await backend.getQuote(validParams);
    expect(quote).toBeNull();
  });

  it("supports both Base→BSC and BSC→Base", async () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [{ estimatedDestinationAmount: "9900", expirationTime: future }],
      }),
    });

    // BSC → Base
    const reverseParams: QuoteParams = {
      ...validParams,
      fromChainId: 56,
      toChainId: 8453,
      fromTokenAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
      toTokenAddress: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      // BTCB is 18 decimals vs cbBTC's 8 — use equivalent amount
      amountRaw: "100000000000000", // 0.0001 BTC in 18-decimal BTCB
    };

    const quote = await backend.getQuote(reverseParams);
    expect(quote).not.toBeNull();
  });
});
