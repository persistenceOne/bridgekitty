import { describe, it, expect } from "vitest";
import { resolveChainId, getChainName, getAllChains, getBackendChainId } from "../../src/utils/chains.js";

describe("resolveChainId", () => {
  it("resolves by name", () => {
    expect(resolveChainId("ethereum")).toBe(1);
    expect(resolveChainId("base")).toBe(8453);
    expect(resolveChainId("arbitrum")).toBe(42161);
  });

  it("resolves by numeric string", () => {
    expect(resolveChainId("1")).toBe(1);
    expect(resolveChainId("8453")).toBe(8453);
  });

  it("is case-insensitive for name match", () => {
    expect(resolveChainId("Ethereum")).toBe(1);
    expect(resolveChainId("BASE")).toBe(8453); // matches via name.toLowerCase()
  });

  it("rejects unknown numeric chain IDs", () => {
    expect(resolveChainId("99999")).toBeNull();
  });

  it("accepts known numeric chain IDs", () => {
    expect(resolveChainId("1")).toBe(1);
    expect(resolveChainId("42161")).toBe(42161);
  });

  it("returns null for unknown names", () => {
    expect(resolveChainId("notachain")).toBeNull();
  });

  it("returns null for negative or zero", () => {
    expect(resolveChainId("0")).toBeNull();
    expect(resolveChainId("-1")).toBeNull();
  });

  it("returns null for floats", () => {
    expect(resolveChainId("1.5")).toBeNull();
  });
});

describe("getChainName", () => {
  it("returns known chain name", () => {
    expect(getChainName(1)).toBe("Ethereum");
    expect(getChainName(8453)).toBe("Base");
  });

  it("returns fallback for unknown chain", () => {
    expect(getChainName(999999)).toBe("Chain 999999");
  });
});

describe("getAllChains", () => {
  it("returns a non-empty array", () => {
    const chains = getAllChains();
    expect(chains.length).toBeGreaterThan(5);
  });

  it("includes Ethereum", () => {
    const chains = getAllChains();
    expect(chains.some((c) => c.id === 1)).toBe(true);
  });
});

describe("getBackendChainId", () => {
  // Solana support removed in v1 — overrides table is now empty
  it("returns original chain ID for any backend (no overrides in v1)", () => {
    expect(getBackendChainId("debridge", 1151111081099710)).toBe(1151111081099710);
  });

  it("returns original chain ID for unknown backends", () => {
    expect(getBackendChainId("lifi", 1)).toBe(1);
  });

  it("returns original chain ID when no override exists", () => {
    expect(getBackendChainId("debridge", 1)).toBe(1);
  });
});
