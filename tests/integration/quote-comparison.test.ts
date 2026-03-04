/**
 * All-backends quote comparison — REAL API integration tests.
 * No mocks. Hits all 5 backend APIs directly.
 *
 * Tests that every backend can return a quote for common routes.
 * Also tests the routing engine's multi-backend aggregation.
 */
import { describe, it, expect } from "vitest";
import { LiFiBackend } from "../../src/backends/lifi.js";
import { DeBridgeBackend } from "../../src/backends/debridge.js";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import type { QuoteParams, BridgeQuote } from "../../src/backends/types.js";

const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TIMEOUT = 30_000; // Some backends are slow

// ── Token addresses ─────────────────────────────────────────────────────
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const NATIVE = "0x0000000000000000000000000000000000000000";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";

describe("All-backends quote comparison (real APIs)", () => {
  // Initialize all backends without API keys (public access)
  const lifi = new LiFiBackend();
  const debridge = new DeBridgeBackend();
  const across = new AcrossBackend();
  const relay = new RelayBackend();
  const persistence = new PersistenceBackend();

  // ─── Individual Backend Quotes ──────────────────────────────────────

  describe("LI.FI", () => {
    it("returns a quote for USDC Base → USDC Arbitrum", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000", // 1 USDC
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await lifi.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;
      expect(quote.backendName).toBe("lifi");
      expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0.5);
      expect(quote.feeBreakdown).toBeDefined();
      expect(quote.estimatedTimeSeconds).toBeGreaterThan(0);
    }, TIMEOUT);

    it("returns multiple routes via getQuotes", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "5000000", // 5 USDC
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quotes = await lifi.getQuotes(params);
      expect(quotes.length).toBeGreaterThanOrEqual(1);
      // All quotes should be LI.FI
      for (const q of quotes) {
        expect(q.backendName).toBe("lifi");
      }
    }, TIMEOUT);
  });

  describe("deBridge", () => {
    it("returns a quote for USDC Base → USDC Arbitrum", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000",
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await debridge.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;
      expect(quote.backendName).toBe("debridge");
      expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0.5);
    }, TIMEOUT);
  });

  describe("Across", () => {
    it("returns a quote for USDC Base → USDC Arbitrum (same-token)", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000",
        fromAddress: TEST_ADDRESS,
        preference: "fastest",
      };

      const quote = await across.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;
      expect(quote.backendName).toBe("across");
      expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0.5);
    }, TIMEOUT);

    it("returns a quote for ETH Base → ETH Arbitrum (native, larger amount)", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: NATIVE,
        toTokenAddress: NATIVE,
        amountRaw: "10000000000000000", // 0.01 ETH (~$18)
        fromAddress: TEST_ADDRESS,
        preference: "fastest",
      };

      const quote = await across.getQuote(params);
      // Across may have minimum amount requirements for native ETH bridging
      if (quote) {
        expect(quote.backendName).toBe("across");
        expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0);
      }
    }, TIMEOUT);
  });

  describe("Relay", () => {
    it("returns a quote for USDC Base → USDC Arbitrum", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "1000000",
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await relay.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;
      expect(quote.backendName).toBe("relay");
      expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0.5);
    }, TIMEOUT);
  });

  describe("Persistence", () => {
    it("returns a quote for cbBTC Base → BTCB BSC", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 56,
        fromTokenAddress: CBBTC_BASE,
        toTokenAddress: BTCB_BSC,
        amountRaw: "5000", // 0.00005 BTC (8 decimals)
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await persistence.getQuote(params);
      expect(quote).not.toBeNull();
      if (!quote) return;
      expect(quote.backendName).toBe("persistence");
      expect(quote.provider).toContain("Persistence");
      expect(parseFloat(quote.outputAmount)).toBeGreaterThan(0);
    }, TIMEOUT);

    it("returns null for unsupported route (Base → Optimism)", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 10,
        fromTokenAddress: CBBTC_BASE,
        toTokenAddress: NATIVE,
        amountRaw: "5000",
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      const quote = await persistence.getQuote(params);
      expect(quote).toBeNull();
    }, TIMEOUT);
  });

  // ─── Cross-backend comparison ──────────────────────────────────────

  describe("Head-to-head comparison", () => {
    it("EVM backends return quotes for USDC Base → USDC Arb", async () => {
      const params: QuoteParams = {
        fromChainId: 8453,
        toChainId: 42161,
        fromTokenAddress: USDC_BASE,
        toTokenAddress: USDC_ARB,
        amountRaw: "5000000", // 5 USDC
        fromAddress: TEST_ADDRESS,
        preference: "cheapest",
      };

      // Fetch all EVM backend quotes in parallel
      const results = await Promise.allSettled([
        lifi.getQuote(params),
        debridge.getQuote(params),
        across.getQuote(params),
        relay.getQuote(params),
      ]);

      const quotes: { backend: string; quote: BridgeQuote }[] = [];
      const backends = ["lifi", "debridge", "across", "relay"];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled" && r.value) {
          quotes.push({ backend: backends[i], quote: r.value });
        } else if (r.status === "rejected") {
          console.warn(`[${backends[i]}] quote failed:`, r.reason?.message);
        }
      }

      // At least 2 out of 4 should return quotes for this common route
      console.log(
        `\n  Quotes received: ${quotes.length}/4`,
        quotes.map((q) => `\n    ${q.backend}: ${q.quote.outputAmount} USDC (${q.quote.route})`).join("")
      );

      expect(quotes.length).toBeGreaterThanOrEqual(2);

      // All returned quotes should have reasonable output (>4 USDC for 5 USDC input)
      for (const { backend, quote } of quotes) {
        const output = parseFloat(quote.outputAmount);
        expect(output, `${backend} output too low: ${output}`).toBeGreaterThan(4);
        expect(output, `${backend} output too high: ${output}`).toBeLessThan(6);
      }
    }, TIMEOUT);
  });
});
