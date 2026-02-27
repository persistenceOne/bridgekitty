import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiFiBackend } from "../../src/backends/lifi.js";
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

describe("LiFiBackend", () => {
  let backend: LiFiBackend;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    backend = new LiFiBackend("test-key", "test-integrator", "0.003");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    expect(backend.name).toBe("lifi");
  });

  it("returns empty array on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const quotes = await backend.getQuotes(validParams);
    expect(quotes).toEqual([]);
  });

  it("returns empty array when no routes found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [] }),
    });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes).toEqual([]);
  });

  it("parses valid route response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [
          {
            toAmount: "99500000",
            gasCostUSD: "0.50",
            steps: [
              {
                tool: "stargate",
                toolDetails: { name: "Stargate" },
                action: {
                  fromToken: { symbol: "USDC", decimals: 6 },
                  toToken: { symbol: "USDC", decimals: 6 },
                },
                estimate: {
                  executionDuration: 120,
                  feeCosts: [
                    { name: "Protocol fee", amountUSD: "0.30" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes.length).toBe(1);
    expect(quotes[0].backendName).toBe("lifi");
    expect(quotes[0].provider).toContain("LI.FI");
    expect(quotes[0].outputAmountRaw).toBe("99500000");
    expect(quotes[0].estimatedTimeSeconds).toBe(120);
    expect(quotes[0].expiresAt).toBeGreaterThan(Date.now());
    expect(quotes[0].feeBreakdown.gasCostUsd).toBeCloseTo(0.5, 1);
  });

  it("includes integrator fee in breakdown when configured", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [
          {
            toAmount: "99500000",
            gasCostUSD: "0.50",
            steps: [
              {
                tool: "stargate",
                action: {
                  fromToken: { symbol: "USDC", decimals: 6 },
                  toToken: { symbol: "USDC", decimals: 6 },
                },
                estimate: {
                  executionDuration: 60,
                  feeCosts: [
                    { name: "Integrator fee", amountUSD: "0.30" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes[0].feeBreakdown.integratorFeePercent).toBe("0.3%");
    expect(quotes[0].feeBreakdown.integratorFeeUsd).toBeCloseTo(0.3, 1);
  });

  // ─── Approval Amount Cap Tests (MEDIUM-001) ─────────────────────────

  it("approval amount within 110% of quoted input passes through", async () => {
    const quotedInput = "100000000"; // 100 USDC
    const approvalAmount = "105000000"; // 105 USDC (105% < 110%)

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          routes: [{
            toAmount: "99500000",
            fromAmount: quotedInput,
            gasCostUSD: "0.50",
            steps: [{
              tool: "stargate",
              action: {
                fromToken: { symbol: "USDC", decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
                toToken: { symbol: "USDC", decimals: 6 },
                fromAmount: quotedInput,
              },
              estimate: {
                executionDuration: 60,
                feeCosts: [],
                approvalAddress: "0x1111111111111111111111111111111111111111",
              },
            }],
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactionRequest: {
            to: "0x2222222222222222222222222222222222222222",
            data: "0xabcdef",
            value: "0x0",
            chainId: 1,
          },
          action: {
            fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            fromAmount: approvalAmount,
          },
          estimate: {
            approvalAddress: "0x1111111111111111111111111111111111111111",
          },
        }),
      });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes.length).toBe(1);
    const tx = await backend.buildTransaction(quotes[0]);
    // Approval should exist and amount should pass through (within 110%)
    expect(tx.approvalTx).toBeDefined();
    // The approval data encodes the amount — verify it contains the original amount
    // 105000000 in hex = 0x6422C40, padded to 64 chars
    const expectedHex = BigInt(approvalAmount).toString(16).padStart(64, "0");
    expect(tx.approvalTx!.data).toContain(expectedHex);
  });

  it("approval amount >110% of quoted input is capped with warning", async () => {
    const quotedInput = "100000000"; // 100 USDC
    const excessiveApproval = "200000000"; // 200% — way over 110%
    const maxAllowed = (BigInt(quotedInput) * 110n / 100n).toString(); // 110000000

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          routes: [{
            toAmount: "99500000",
            fromAmount: quotedInput,
            gasCostUSD: "0.50",
            steps: [{
              tool: "stargate",
              action: {
                fromToken: { symbol: "USDC", decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
                toToken: { symbol: "USDC", decimals: 6 },
                fromAmount: quotedInput,
              },
              estimate: {
                executionDuration: 60,
                feeCosts: [],
                approvalAddress: "0x1111111111111111111111111111111111111111",
              },
            }],
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactionRequest: {
            to: "0x2222222222222222222222222222222222222222",
            data: "0xabcdef",
            value: "0x0",
            chainId: 1,
          },
          action: {
            fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            fromAmount: excessiveApproval,
          },
          estimate: {
            approvalAddress: "0x1111111111111111111111111111111111111111",
          },
        }),
      });

    const quotes = await backend.getQuotes(validParams);
    const tx = await backend.buildTransaction(quotes[0]);

    expect(tx.approvalTx).toBeDefined();
    // Should be capped to 110% of quoted input
    const cappedHex = BigInt(maxAllowed).toString(16).padStart(64, "0");
    expect(tx.approvalTx!.data).toContain(cappedHex);

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exceeds 110%"),
    );

    warnSpy.mockRestore();
  });

  it("limits to 5 routes", async () => {
    const routes = Array.from({ length: 10 }, (_, i) => ({
      toAmount: String(99000000 - i * 100000),
      gasCostUSD: "0.50",
      steps: [
        {
          tool: `tool${i}`,
          action: {
            fromToken: { symbol: "USDC", decimals: 6 },
            toToken: { symbol: "USDC", decimals: 6 },
          },
          estimate: { executionDuration: 60, feeCosts: [] },
        },
      ],
    }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ routes }),
    });

    const quotes = await backend.getQuotes(validParams);
    expect(quotes.length).toBe(5);
  });
});
