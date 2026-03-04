import { describe, it, expect } from "vitest";

describe("Gas fee transparency", () => {
  // Test the gas fee display logic (mirrors get-quote.ts formatGasFee behavior)

  function formatGasFee(gasCostUsd: number | null | undefined, backendName: string): string {
    if (gasCostUsd === null || gasCostUsd === undefined) {
      return "unknown";
    }
    if (gasCostUsd > 0 && gasCostUsd < 0.01) {
      return "<$0.01";
    }
    if (gasCostUsd > 0) {
      const GAS_ESTIMATED_BACKENDS = new Set(["debridge", "across", "persistence"]);
      if (GAS_ESTIMATED_BACKENDS.has(backendName)) {
        return `~$${gasCostUsd.toFixed(2)} (est)`;
      }
      return `$${gasCostUsd.toFixed(2)}`;
    }
    return "$0.00";
  }

  function getFeeModel(backendName: string): string {
    if (backendName === "relay") return "gas_included_in_spread";
    if (backendName === "persistence") return "gasless_relay";
    return "user_pays_gas";
  }

  function getGasEstimateNote(chainId: number): string | null {
    const L2_CHAINS = new Set([10, 8453, 42161, 534352, 59144, 324, 81457, 5000, 34443]);
    if (L2_CHAINS.has(chainId)) {
      const chainNames: Record<number, string> = {
        10: "Optimism", 8453: "Base", 42161: "Arbitrum", 534352: "Scroll",
        59144: "Linea", 324: "zkSync", 81457: "Blast", 5000: "Mantle", 34443: "Mode",
      };
      const name = chainNames[chainId] || "this L2";
      return `Gas on ${name} L2 is typically <$0.01`;
    }
    return null;
  }

  describe("formatGasFee", () => {
    it("shows <$0.01 for sub-cent gas fees instead of $0.00", () => {
      expect(formatGasFee(0.003, "lifi")).toBe("<$0.01");
      expect(formatGasFee(0.001, "squid")).toBe("<$0.01");
      expect(formatGasFee(0.009, "across")).toBe("<$0.01");
    });

    it("shows unknown for null/undefined gas", () => {
      expect(formatGasFee(null, "lifi")).toBe("unknown");
      expect(formatGasFee(undefined, "relay")).toBe("unknown");
    });

    it("shows estimated label for backends with estimated gas", () => {
      expect(formatGasFee(0.05, "debridge")).toBe("~$0.05 (est)");
      expect(formatGasFee(1.5, "persistence")).toBe("~$1.50 (est)");
      expect(formatGasFee(0.03, "across")).toBe("~$0.03 (est)");
    });

    it("shows plain dollar amount for backends with precise gas", () => {
      expect(formatGasFee(0.05, "lifi")).toBe("$0.05");
      expect(formatGasFee(2.30, "squid")).toBe("$2.30");
    });

    it("shows $0.00 when gas is exactly zero", () => {
      expect(formatGasFee(0, "relay")).toBe("$0.00");
    });
  });

  describe("getFeeModel", () => {
    it("returns gas_included_in_spread for Relay", () => {
      expect(getFeeModel("relay")).toBe("gas_included_in_spread");
    });

    it("returns gasless_relay for Persistence", () => {
      expect(getFeeModel("persistence")).toBe("gasless_relay");
    });

    it("returns user_pays_gas for other backends", () => {
      expect(getFeeModel("lifi")).toBe("user_pays_gas");
      expect(getFeeModel("squid")).toBe("user_pays_gas");
      expect(getFeeModel("debridge")).toBe("user_pays_gas");
      expect(getFeeModel("across")).toBe("user_pays_gas");
    });
  });

  describe("getGasEstimateNote", () => {
    it("returns L2 note for L2 chains", () => {
      expect(getGasEstimateNote(8453)).toBe("Gas on Base L2 is typically <$0.01");
      expect(getGasEstimateNote(42161)).toBe("Gas on Arbitrum L2 is typically <$0.01");
      expect(getGasEstimateNote(10)).toBe("Gas on Optimism L2 is typically <$0.01");
    });

    it("returns null for L1 chains", () => {
      expect(getGasEstimateNote(1)).toBeNull(); // Ethereum
      expect(getGasEstimateNote(56)).toBeNull(); // BSC
      expect(getGasEstimateNote(137)).toBeNull(); // Polygon
    });
  });
});
