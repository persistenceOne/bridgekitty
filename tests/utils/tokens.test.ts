import { describe, it, expect } from "vitest";
import { resolveTokenAddress, formatTokenAmount, parseTokenAmount } from "../../src/utils/tokens.js";

describe("resolveTokenAddress", () => {
  it("resolves USDC on Ethereum", () => {
    const result = resolveTokenAddress("USDC", 1);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(result!.decimals).toBe(6);
  });

  it("resolves ETH on Base as native", () => {
    const result = resolveTokenAddress("ETH", 8453);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0x0000000000000000000000000000000000000000");
    expect(result!.decimals).toBe(18);
  });

  it("returns null for unknown symbol", () => {
    const result = resolveTokenAddress("NOTAREAL", 1);
    expect(result).toBeNull();
  });

  it("returns null for known token on unsupported chain", () => {
    const result = resolveTokenAddress("BNB", 1); // BNB not on Ethereum
    expect(result).toBeNull();
  });

  it("passes through hex addresses", () => {
    const result = resolveTokenAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  });

  it("is case-insensitive for symbols", () => {
    const result = resolveTokenAddress("usdc", 1);
    expect(result).not.toBeNull();
    expect(result!.decimals).toBe(6);
  });

  // New tokens from expanded registry
  it("resolves BTCB on BSC", () => {
    const result = resolveTokenAddress("BTCB", 56);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c");
  });

  it("resolves WETH on Arbitrum", () => {
    const result = resolveTokenAddress("WETH", 42161);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
  });

  it("resolves wstETH on Ethereum", () => {
    const result = resolveTokenAddress("WSTETH", 1);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
  });

  it("resolves cbBTC on Base", () => {
    const result = resolveTokenAddress("CBBTC", 8453);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
  });
});

describe("formatTokenAmount", () => {
  it("formats zero", () => {
    expect(formatTokenAmount("0", 18)).toBe("0");
  });

  it("formats USDC (6 decimals)", () => {
    expect(formatTokenAmount("100000000", 6)).toBe("100");
  });

  it("formats ETH (18 decimals)", () => {
    expect(formatTokenAmount("1000000000000000000", 18)).toBe("1");
  });

  it("formats fractional amounts", () => {
    expect(formatTokenAmount("1500000", 6)).toBe("1.5");
  });

  it("handles empty string", () => {
    expect(formatTokenAmount("", 18)).toBe("0");
  });

  it("trims trailing zeros in decimals", () => {
    expect(formatTokenAmount("1000000000000000000", 18)).toBe("1");
    // Not "1.000000000000000000"
  });

  it("limits to 8 decimal places", () => {
    // 0.123456789012345678 → should show at most 8 decimals
    expect(formatTokenAmount("123456789012345678", 18)).toBe("0.12345678");
  });
});

describe("parseTokenAmount", () => {
  it("parses integer USDC", () => {
    expect(parseTokenAmount("100", 6)).toBe("100000000");
  });

  it("parses fractional USDC", () => {
    expect(parseTokenAmount("1.5", 6)).toBe("1500000");
  });

  it("parses ETH", () => {
    expect(parseTokenAmount("1", 18)).toBe("1000000000000000000");
  });

  it("parses zero", () => {
    expect(parseTokenAmount("0", 18)).toBe("0");
  });

  it("truncates excess decimals", () => {
    // 1.1234567 with 6 decimals → truncated to 1.123456
    expect(parseTokenAmount("1.1234567", 6)).toBe("1123456");
  });

  it("handles amount with no fractional part", () => {
    expect(parseTokenAmount("42", 6)).toBe("42000000");
  });
});
