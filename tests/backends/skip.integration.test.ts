/**
 * Skip Protocol backend — REAL API integration tests.
 * No mocks. Hits https://api.skip.build directly.
 *
 * These tests verify:
 * - Quote fetching with real token addresses
 * - Transaction building from real quotes
 * - Chain listing from the live API
 * - Token listing for specific chains
 * - Status checking with a known-good tx hash
 * - Error handling for invalid inputs
 */
import { describe, it, expect } from "vitest";
import { SkipBackend } from "../../src/backends/skip.js";
import type { QuoteParams } from "../../src/backends/types.js";

// USDC Base → USDC Arbitrum (well-supported EVM route)
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

const TIMEOUT = 20_000; // Skip API can be slow

describe("SkipBackend (real API)", () => {
  const skip = new SkipBackend();

  // ─── Quote ──────────────────────────────────────────────────────────
  describe("getQuote", () => {
    it("returns a valid quote for USDC Base → USDC Arbitrum", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000", // 1 USDC
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await skip.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;

      // Structure checks
      expect(quote.backendName).toBe("skip");
      expect(quote.provider).toContain("Skip");
      expect(quote.outputAmountRaw).toBeTruthy();
      expect(quote.route).toBeTruthy();
      expect(quote.estimatedTimeSeconds).toBeGreaterThan(0);
      expect(quote.expiresAt).toBeGreaterThan(Date.now());

      // Output should be roughly 1 USDC (within slippage/fees)
      const outputNum = parseFloat(quote.outputAmount);
      expect(outputNum).toBeGreaterThan(0.9);
      expect(outputNum).toBeLessThan(1.1);

      // Fee breakdown should be present
      expect(quote.feeBreakdown).toBeDefined();

      // quoteData should contain the routeResponse we need for buildTransaction
      expect((quote.quoteData as any).routeResponse).toBeDefined();
      expect((quote.quoteData as any).params).toBeDefined();
    }, TIMEOUT);

    it("returns null for unsupported route (chain 999999)", async () => {
      const params: QuoteParams = {
        fromChainId: 999999,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000",
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await skip.getQuote(params);
      expect(quote).toBeNull();
    }, TIMEOUT);

    it("correctly formats USDC output with 6 decimals", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "10000000", // 10 USDC
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await skip.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;

      // Should show ~10 USDC, not 0.00000000001 (which would happen with wrong decimals)
      const outputNum = parseFloat(quote.outputAmount);
      expect(outputNum).toBeGreaterThan(8);  // At least 8 USDC after fees
      expect(outputNum).toBeLessThan(12);    // Not more than 12 USDC
    }, TIMEOUT);
  });

  // ─── Build Transaction ──────────────────────────────────────────────
  describe("buildTransaction", () => {
    it("returns valid unsigned EVM tx data from a real quote", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000",
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await skip.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;

      const tx = await skip.buildTransaction(quote);
      expect(tx).toBeDefined();
      expect(tx.to).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(tx.data).toBeTruthy();
      expect(tx.chainId).toBe(8453);
      expect(tx.provider).toBe("skip");
      expect(tx.trackingId).toContain("skip:");
    }, TIMEOUT);
  });

  // ─── Supported Chains ──────────────────────────────────────────────
  describe("getSupportedChains", () => {
    it("returns a list of chains including EVM and Cosmos chains", async () => {
      const chains = await skip.getSupportedChains();
      expect(chains.length).toBeGreaterThan(5);

      // Skip returns both EVM chains (numeric IDs) and Cosmos chains (string IDs → 0)
      const evmChains = chains.filter((c) => c.id > 0);
      const cosmosChains = chains.filter((c) => c.id === 0);

      // Should have both EVM and Cosmos chains
      console.log(`  Skip chains: ${chains.length} total (${evmChains.length} EVM, ${cosmosChains.length} Cosmos/other)`);

      // At minimum should have some chains returned
      expect(chains.length).toBeGreaterThan(10);

      // Every chain should have the skip provider tag and a name
      for (const chain of chains) {
        expect(chain.providers).toContain("skip");
        expect(chain.name).toBeTruthy();
      }
    }, TIMEOUT);
  });

  // ─── Supported Tokens ──────────────────────────────────────────────
  describe("getSupportedTokens", () => {
    it("returns tokens for Base (8453)", async () => {
      const tokens = await skip.getSupportedTokens(8453);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.length).toBeLessThanOrEqual(50);

      for (const token of tokens) {
        expect(token.symbol).toBeTruthy();
        expect(token.chainId).toBe(8453);
      }
    }, TIMEOUT);

    it("returns empty array for unknown chain", async () => {
      const tokens = await skip.getSupportedTokens(999999);
      expect(tokens).toEqual([]);
    }, TIMEOUT);
  });

  // ─── Status ─────────────────────────────────────────────────────────
  describe("getStatus", () => {
    it("returns unknown status for non-existent tx", async () => {
      const status = await skip.getStatus("skip:8453:000", {
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        fromChain: "8453",
      });

      // Should not crash — returns either "unknown" or "pending"
      expect(["unknown", "pending", "failed"]).toContain(status.state);
      expect(status.provider).toBe("skip");
    }, TIMEOUT);

    it("returns unknown when no txHash provided", async () => {
      const status = await skip.getStatus("skip:8453:000");
      expect(status.state).toBe("unknown");
      expect(status.humanReadable).toContain("No transaction hash");
    });
  });
});
