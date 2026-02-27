import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { simulateTransaction } from "../../src/utils/tx-simulator.js";

describe("simulateTransaction", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseTx = {
    to: "0x1234567890123456789012345678901234567890",
    data: "0xabcdef",
    value: "0x0",
  };

  it("returns warning for unknown chain", async () => {
    const result = await simulateTransaction(999999, baseTx);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("No RPC configured");
  });

  it("returns gas estimate on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: "0x5208", // 21000 gas
      }),
    });

    const result = await simulateTransaction(1, baseTx);
    expect(result.success).toBe(true);
    expect(result.estimatedGas).toBe("0x5208");
    expect(result.error).toBeUndefined();
  });

  it("returns error on revert", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "execution reverted: ERC20: transfer amount exceeds balance" },
      }),
    });

    const result = await simulateTransaction(1, baseTx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("execution reverted");
  });

  it("returns warning on insufficient funds (expected in simulation)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "insufficient funds for gas * price + value" },
      }),
    });

    const result = await simulateTransaction(1, baseTx);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("insufficient balance");
  });

  it("returns warning on RPC HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const result = await simulateTransaction(1, baseTx);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("503");
  });

  it("returns warning on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await simulateTransaction(1, baseTx);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("ECONNREFUSED");
  });

  it("handles non-hex value", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: "0x5208",
      }),
    });

    const result = await simulateTransaction(1, {
      ...baseTx,
      value: "1000000000000000000", // 1 ETH in decimal
    });
    expect(result.success).toBe(true);
    expect(result.estimatedGas).toBe("0x5208");

    // Verify the fetch was called with hex value
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.params[0].value).toBe("0xde0b6b3a7640000");
  });
});
