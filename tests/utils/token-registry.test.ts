import { describe, it, expect } from "vitest";
import {
  resolveToken,
  lookupByAddress,
  getVerifiedTokensForChain,
  getRegistryStats,
  VERIFIED_TOKENS,
} from "../../src/utils/token-registry.js";

// ─── resolveToken: Symbol Resolution ────────────────────────────────────────

describe("resolveToken", () => {
  describe("symbol resolution", () => {
    it("resolves USDC on Ethereum", () => {
      const result = resolveToken("USDC", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        expect(result.decimals).toBe(6);
        expect(result.symbol).toBe("USDC");
      }
    });

    it("resolves USDC on BSC with 18 decimals (not 6)", () => {
      const result = resolveToken("USDC", 56);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
        expect(result.decimals).toBe(18); // BSC uses 18 decimals
      }
    });

    it("resolves USDT on Ethereum with 6 decimals", () => {
      const result = resolveToken("USDT", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decimals).toBe(6);
      }
    });

    it("resolves USDT on BSC with 18 decimals (not 6)", () => {
      const result = resolveToken("USDT", 56);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x55d398326f99059fF775485246999027B3197955");
        expect(result.decimals).toBe(18); // BSC uses 18 decimals
      }
    });

    it("resolves USDC on Base (different address than Ethereum)", () => {
      const result = resolveToken("USDC", 8453);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
        expect(result.decimals).toBe(6);
      }
    });

    it("resolves USDC on Arbitrum", () => {
      const result = resolveToken("USDC", 42161);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
      }
    });

    it("resolves USDC on different chains to different addresses", () => {
      const eth = resolveToken("USDC", 1);
      const base = resolveToken("USDC", 8453);
      const arb = resolveToken("USDC", 42161);
      expect(eth.ok && base.ok && arb.ok).toBe(true);
      if (eth.ok && base.ok && arb.ok) {
        expect(eth.address).not.toBe(base.address);
        expect(eth.address).not.toBe(arb.address);
        expect(base.address).not.toBe(arb.address);
      }
    });

    it("resolves ETH as native token on multiple chains", () => {
      const chains = [1, 10, 42161, 8453];
      for (const chainId of chains) {
        const result = resolveToken("ETH", chainId);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.address).toBe("0x0000000000000000000000000000000000000000");
          expect(result.decimals).toBe(18);
        }
      }
    });

    it("resolves BNB as native on BSC", () => {
      const result = resolveToken("BNB", 56);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x0000000000000000000000000000000000000000");
        expect(result.decimals).toBe(18);
      }
    });

    it("resolves BTCB on BSC", () => {
      const result = resolveToken("BTCB", 56);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c");
        expect(result.decimals).toBe(18);
      }
    });

    it("resolves cbBTC on Base", () => {
      const result = resolveToken("CBBTC", 8453);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
        expect(result.decimals).toBe(8);
      }
    });

    it("resolves WETH on various chains", () => {
      const wethEth = resolveToken("WETH", 1);
      const wethBase = resolveToken("WETH", 8453);
      expect(wethEth.ok).toBe(true);
      expect(wethBase.ok).toBe(true);
      if (wethEth.ok) {
        expect(wethEth.address).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
      }
      if (wethBase.ok) {
        expect(wethBase.address).toBe("0x4200000000000000000000000000000000000006");
      }
    });

    it("resolves WBTC on Ethereum", () => {
      const result = resolveToken("WBTC", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
        expect(result.decimals).toBe(8);
      }
    });

    it("resolves wstETH on Ethereum", () => {
      const result = resolveToken("WSTETH", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
        expect(result.decimals).toBe(18);
      }
    });

    it("resolves DAI on Ethereum", () => {
      const result = resolveToken("DAI", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x6B175474E89094C44Da98b954EedeAC495271d0F");
        expect(result.decimals).toBe(18);
      }
    });

    it("resolves ARB on Arbitrum", () => {
      const result = resolveToken("ARB", 42161);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x912CE59144191C1204E64559FE8253a0e49E6548");
        expect(result.decimals).toBe(18);
      }
    });

    it("resolves OP on Optimism", () => {
      const result = resolveToken("OP", 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x4200000000000000000000000000000000000042");
      }
    });

    it("resolves USDC.e bridged variant", () => {
      const result = resolveToken("USDC.E", 42161);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8");
        expect(result.decimals).toBe(6);
      }
    });

    it("resolves LINK on Ethereum", () => {
      const result = resolveToken("LINK", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x514910771AF9Ca656af840dff83E8264EcF986CA");
      }
    });
  });

  describe("case insensitivity", () => {
    it("resolves lowercase 'usdc'", () => {
      const result = resolveToken("usdc", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      }
    });

    it("resolves mixed case 'Usdc'", () => {
      const result = resolveToken("Usdc", 1);
      expect(result.ok).toBe(true);
    });

    it("resolves 'eth' lowercase", () => {
      const result = resolveToken("eth", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0x0000000000000000000000000000000000000000");
      }
    });

    it("resolves 'wsteth' lowercase", () => {
      const result = resolveToken("wsteth", 1);
      expect(result.ok).toBe(true);
    });
  });

  describe("0x address passthrough", () => {
    it("passes through a valid 0x address", () => {
      const addr = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const result = resolveToken(addr, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe(addr);
        expect(result.decimals).toBe(6); // Known USDC address
        expect(result.symbol).toBe("USDC");
      }
    });

    it("passes through unknown 0x address with default decimals", () => {
      const addr = "0x1234567890123456789012345678901234567890";
      const result = resolveToken(addr, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe(addr);
        expect(result.decimals).toBe(18); // Default
        expect(result.symbol).toBe("UNKNOWN");
      }
    });

    it("looks up decimals for known WBTC address", () => {
      const addr = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
      const result = resolveToken(addr, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decimals).toBe(8);
        expect(result.symbol).toBe("WBTC");
      }
    });
  });

  describe("rejection: unknown symbols", () => {
    it("rejects unknown symbol with helpful error", () => {
      const result = resolveToken("FAKECOIN", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Unknown token symbol 'FAKECOIN'");
        expect(result.error).toContain("Ethereum");
        expect(result.error).toContain("bridge_tokens");
      }
    });

    it("rejects empty string", () => {
      const result = resolveToken("", 1);
      expect(result.ok).toBe(false);
    });

    it("rejects random strings", () => {
      const result = resolveToken("hello", 1);
      expect(result.ok).toBe(false);
    });
  });

  describe("rejection: token not on chain", () => {
    it("rejects BNB on Ethereum (not deployed there)", () => {
      const result = resolveToken("BNB", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not available on Ethereum");
        expect(result.error).toContain("BNB Chain"); // Tells you where it IS available
      }
    });

    it("rejects BTCB on Ethereum", () => {
      const result = resolveToken("BTCB", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not available");
        expect(result.error).toContain("BNB Chain");
      }
    });

    it("rejects AVAX on Ethereum", () => {
      const result = resolveToken("AVAX", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not available on Ethereum");
        expect(result.error).toContain("Avalanche");
      }
    });

    it("rejects stETH on Base (only on Ethereum)", () => {
      const result = resolveToken("STETH", 8453);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not available on Base");
      }
    });
  });

  describe("whitespace handling", () => {
    it("trims leading/trailing whitespace", () => {
      const result = resolveToken("  USDC  ", 1);
      expect(result.ok).toBe(true);
    });

    it("trims whitespace from address", () => {
      const result = resolveToken("  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  ", 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      }
    });
  });
});

// ─── lookupByAddress ────────────────────────────────────────────────────────

describe("lookupByAddress", () => {
  it("finds USDC by address on Ethereum", () => {
    const token = lookupByAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe("USDC");
    expect(token!.decimals).toBe(6);
  });

  it("finds USDC by lowercase address", () => {
    const token = lookupByAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 1);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe("USDC");
  });

  it("returns null for unknown address", () => {
    const token = lookupByAddress("0x1234567890123456789012345678901234567890", 1);
    expect(token).toBeNull();
  });

  it("returns null for known address on wrong chain", () => {
    // BTCB address is on BSC (56), not Ethereum (1)
    const token = lookupByAddress("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", 1);
    expect(token).toBeNull();
  });
});

// ─── getVerifiedTokensForChain ──────────────────────────────────────────────

describe("getVerifiedTokensForChain", () => {
  it("returns tokens for Ethereum", () => {
    const tokens = getVerifiedTokensForChain(1);
    expect(tokens.length).toBeGreaterThan(10);
    const symbols = tokens.map((t) => t.symbol);
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("USDT");
    expect(symbols).toContain("WETH");
    expect(symbols).toContain("WBTC");
    expect(symbols).toContain("DAI");
  });

  it("returns tokens for BSC", () => {
    const tokens = getVerifiedTokensForChain(56);
    const symbols = tokens.map((t) => t.symbol);
    expect(symbols).toContain("BNB");
    expect(symbols).toContain("BTCB");
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("USDT");
  });

  it("returns tokens for Base", () => {
    const tokens = getVerifiedTokensForChain(8453);
    const symbols = tokens.map((t) => t.symbol);
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("CBBTC");
    expect(symbols).toContain("WETH");
  });

  it("returns empty array for unknown chain", () => {
    const tokens = getVerifiedTokensForChain(999999);
    expect(tokens).toEqual([]);
  });
});

// ─── getRegistryStats ───────────────────────────────────────────────────────

describe("getRegistryStats", () => {
  it("reports reasonable token and chain counts", () => {
    const stats = getRegistryStats();
    expect(stats.tokenCount).toBeGreaterThan(30);
    expect(stats.chainCount).toBeGreaterThan(5);
  });
});

// ─── Registry Data Integrity ────────────────────────────────────────────────

describe("registry data integrity", () => {
  it("all addresses are valid hex format or Cosmos denom", () => {
    // EVM addresses: 0x + 40 hex chars.
    // Cosmos denoms (e.g. uxprt, uatom, ibc/..., stk/uatom) are NOT hex — allow them.
    const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
    const COSMOS_DENOM = /^(u[a-z]+|ibc\/[A-F0-9]+|stk\/.+)$/;
    for (const token of VERIFIED_TOKENS) {
      for (const [chainId, address] of Object.entries(token.addresses)) {
        const valid = EVM_ADDRESS.test(address) || COSMOS_DENOM.test(address);
        expect(valid).toBe(
          true,
          `Invalid address for ${token.symbol} on chain ${chainId}: ${address}`
        );
      }
    }
  });

  it("all symbols are non-empty uppercase", () => {
    for (const token of VERIFIED_TOKENS) {
      expect(token.symbol).toBe(token.symbol.toUpperCase());
      expect(token.symbol.length).toBeGreaterThan(0);
    }
  });

  it("all decimals are reasonable (0-18)", () => {
    for (const token of VERIFIED_TOKENS) {
      expect(token.decimals).toBeGreaterThanOrEqual(0);
      expect(token.decimals).toBeLessThanOrEqual(18);
    }
  });

  it("all tokens have at least one chain address", () => {
    for (const token of VERIFIED_TOKENS) {
      expect(Object.keys(token.addresses).length).toBeGreaterThan(0);
    }
  });

  it("native tokens use zero address", () => {
    const nativeTokens = ["ETH", "BNB", "MATIC", "POL", "AVAX", "MNT"];
    for (const symbol of nativeTokens) {
      const token = VERIFIED_TOKENS.find((t) => t.symbol === symbol);
      if (token) {
        for (const address of Object.values(token.addresses)) {
          expect(address).toBe("0x0000000000000000000000000000000000000000");
        }
      }
    }
  });

  it("USDC has 6 decimals everywhere", () => {
    const usdc = VERIFIED_TOKENS.find((t) => t.symbol === "USDC");
    expect(usdc).toBeDefined();
    expect(usdc!.decimals).toBe(6);
  });

  it("WBTC has 8 decimals", () => {
    const wbtc = VERIFIED_TOKENS.find((t) => t.symbol === "WBTC");
    expect(wbtc).toBeDefined();
    expect(wbtc!.decimals).toBe(8);
  });
});
