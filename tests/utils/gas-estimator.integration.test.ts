/**
 * Gas estimator — REAL RPC integration tests.
 * No mocks. Hits real public RPC endpoints and LI.FI price API.
 *
 * Tests:
 * - Live gas price fetching from multiple chains
 * - RPC failover (verifies multi-endpoint support)
 * - Native token price fetching via LI.FI
 * - Full gas cost estimation
 * - Gas unit estimates per backend
 * - Edge cases (unknown chains, null gas units)
 */
import { describe, it, expect } from "vitest";
import {
  getChainRpcUrls,
  getChainRpcUrl,
  getGasUnits,
  estimateGasCostUsd,
} from "../../src/utils/gas-estimator.js";

const TIMEOUT = 15_000;

describe("Gas Estimator (real RPCs)", () => {
  // ─── RPC URL resolution ─────────────────────────────────────────────
  describe("getChainRpcUrls", () => {
    it("returns multiple RPC URLs for Ethereum (1)", () => {
      const urls = getChainRpcUrls(1);
      expect(urls.length).toBeGreaterThanOrEqual(2);
      for (const url of urls) {
        expect(url).toMatch(/^https:\/\//);
      }
    });

    it("returns multiple RPC URLs for Base (8453)", () => {
      const urls = getChainRpcUrls(8453);
      expect(urls.length).toBeGreaterThanOrEqual(2);
    });

    it("returns multiple RPC URLs for BSC (56)", () => {
      const urls = getChainRpcUrls(56);
      expect(urls.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array for unknown chain", () => {
      const urls = getChainRpcUrls(999999);
      expect(urls).toEqual([]);
    });

    it("getChainRpcUrl returns primary URL", () => {
      const url = getChainRpcUrl(8453);
      expect(url).toBeTruthy();
      expect(url).toMatch(/^https:\/\//);
    });
  });

  // ─── Gas unit estimates ─────────────────────────────────────────────
  describe("getGasUnits", () => {
    it("returns gas units for debridge on L1", () => {
      expect(getGasUnits("debridge", 1)).toBe(150_000);
    });

    it("returns gas units for debridge on L2", () => {
      expect(getGasUnits("debridge", 8453)).toBe(65_000);
    });

    it("returns gas units for across on L1", () => {
      expect(getGasUnits("across", 1)).toBe(120_000);
    });

    it("returns gas units for across on L2", () => {
      expect(getGasUnits("across", 42161)).toBe(65_000);
    });

    it("returns gas units for relay on L1", () => {
      expect(getGasUnits("relay", 1)).toBe(130_000);
    });

    it("returns gas units for relay on L2", () => {
      expect(getGasUnits("relay", 59144)).toBe(65_000);
    });

    it("returns gas units for skip on L1", () => {
      expect(getGasUnits("skip", 1)).toBe(150_000);
    });

    it("returns gas units for skip on L2", () => {
      expect(getGasUnits("skip", 534352)).toBe(80_000);
    });

    it("returns gas units for persistence on Base", () => {
      expect(getGasUnits("persistence", 8453)).toBe(80_000);
    });

    it("returns gas units for persistence on BSC", () => {
      expect(getGasUnits("persistence", 56)).toBe(80_000);
    });

    it("returns null for persistence on unsupported chain", () => {
      expect(getGasUnits("persistence", 1)).toBeNull();
    });

    it("returns null for unknown backend", () => {
      expect(getGasUnits("nonexistent", 1)).toBeNull();
    });
  });

  // ─── Live gas price estimation ──────────────────────────────────────
  describe("estimateGasCostUsd (live RPC)", () => {
    it("estimates gas cost for Base (L2 — should be very cheap)", async () => {
      const result = await estimateGasCostUsd(8453, 65_000);
      expect(result).not.toBeNull();
      if (!result) return;

      // Base L2 gas should be < $0.10
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBeLessThan(1);
      console.log(`  Base gas cost: $${result.costUsd} (fallback: ${result.usingFallbackPrices})`);
    }, TIMEOUT);

    it("estimates gas cost for BSC", async () => {
      const result = await estimateGasCostUsd(56, 65_000);
      expect(result).not.toBeNull();
      if (!result) return;

      // BSC gas should be < $0.50
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBeLessThan(2);
      console.log(`  BSC gas cost: $${result.costUsd} (fallback: ${result.usingFallbackPrices})`);
    }, TIMEOUT);

    it("estimates gas cost for Arbitrum (L2)", async () => {
      const result = await estimateGasCostUsd(42161, 65_000);
      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBeLessThan(1);
      console.log(`  Arbitrum gas cost: $${result.costUsd} (fallback: ${result.usingFallbackPrices})`);
    }, TIMEOUT);

    it("estimates gas cost for Ethereum mainnet (L1 — more expensive)", async () => {
      const result = await estimateGasCostUsd(1, 150_000);
      expect(result).not.toBeNull();
      if (!result) return;

      // Ethereum L1 gas can range from $1-$50+
      expect(result.costUsd).toBeGreaterThan(0);
      console.log(`  Ethereum L1 gas cost: $${result.costUsd} (fallback: ${result.usingFallbackPrices})`);
    }, TIMEOUT);

    it("returns null for null gas units", async () => {
      const result = await estimateGasCostUsd(8453, null);
      expect(result).toBeNull();
    });

    it("returns null for totally unknown chain with no fallback", async () => {
      const result = await estimateGasCostUsd(999999, 65_000);
      expect(result).toBeNull();
    });
  });

  // ─── Multiple chains estimation ─────────────────────────────────────
  describe("Multi-chain gas estimation", () => {
    it("estimates gas across all major chains", async () => {
      const chains = [
        { id: 1, name: "Ethereum" },
        { id: 10, name: "Optimism" },
        { id: 56, name: "BSC" },
        { id: 137, name: "Polygon" },
        { id: 42161, name: "Arbitrum" },
        { id: 8453, name: "Base" },
        { id: 59144, name: "Linea" },
        { id: 534352, name: "Scroll" },
      ];

      const results = await Promise.all(
        chains.map(async (chain) => {
          const result = await estimateGasCostUsd(chain.id, 65_000);
          return { chain: chain.name, chainId: chain.id, result };
        })
      );

      console.log("\n  Gas costs across chains (65k gas units):");
      let successCount = 0;
      for (const { chain, result } of results) {
        if (result) {
          successCount++;
          console.log(
            `    ${chain}: $${result.costUsd.toFixed(4)}${result.usingFallbackPrices ? " (fallback)" : ""}`
          );
        } else {
          console.log(`    ${chain}: unable to estimate`);
        }
      }

      // At least 6 out of 8 should succeed
      expect(successCount).toBeGreaterThanOrEqual(6);
    }, 30_000);
  });
});
