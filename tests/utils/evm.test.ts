import { describe, it, expect, vi } from "vitest";
import { buildApproveData, isValidEvmAddress, isNativeToken, NATIVE_ADDRESS } from "../../src/utils/evm.js";

describe("buildApproveData", () => {
  it("encodes approve(address,uint256) correctly", () => {
    const data = buildApproveData(
      "0x1234567890abcdef1234567890abcdef12345678",
      "1000000"
    );
    expect(data).toMatch(/^0x095ea7b3/); // approve selector
    expect(data.length).toBe(2 + 8 + 64 + 64); // 0x + selector + address + amount
  });

  it("pads small amounts correctly", () => {
    const data = buildApproveData(
      "0x0000000000000000000000000000000000000001",
      "1"
    );
    expect(data).toContain("0".repeat(63) + "1"); // amount = 1 padded to 64 hex chars
  });
});

describe("isValidEvmAddress", () => {
  it("accepts valid checksummed address", () => {
    expect(isValidEvmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
  });

  it("accepts valid lowercase address", () => {
    expect(isValidEvmAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(true);
  });

  it("accepts zero address", () => {
    expect(isValidEvmAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });

  it("rejects too short", () => {
    expect(isValidEvmAddress("0x1234")).toBe(false);
  });

  it("rejects no 0x prefix", () => {
    expect(isValidEvmAddress("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidEvmAddress("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidEvmAddress("0xG0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(false);
  });
});

describe("isValidEvmAddress — EIP-55 checksum", () => {
  it("accepts lowercase address", () => {
    expect(isValidEvmAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(true);
  });

  it("accepts properly checksummed address", () => {
    expect(isValidEvmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
  });

  it("accepts invalid mixed-case address but generates warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // This is mixed-case but NOT valid EIP-55 checksum
    const result = isValidEvmAddress("0xA0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(result).toBe(true); // accepted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MEDIUM-002"),
    );
    warnSpy.mockRestore();
  });

  it("rejects non-hex strings", () => {
    expect(isValidEvmAddress("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
    expect(isValidEvmAddress("not-an-address")).toBe(false);
  });
});

describe("isNativeToken", () => {
  it("recognizes zero address", () => {
    expect(isNativeToken(NATIVE_ADDRESS)).toBe(true);
  });

  it("recognizes 0xEeee... convention", () => {
    expect(isNativeToken("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(true);
  });

  it("rejects regular ERC20 address", () => {
    expect(isNativeToken("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(false);
  });
});
