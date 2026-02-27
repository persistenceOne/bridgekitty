// Token resolution and amount formatting utilities
// Symbol resolution delegates to the verified token registry.

import { resolveToken, lookupByAddress, type TokenResolveResult } from "./token-registry.js";

// Re-export registry types and functions for convenience
export { resolveToken, lookupByAddress, type TokenResolveResult } from "./token-registry.js";

/**
 * Resolve a token symbol or address to { address, decimals }.
 *
 * Returns null if:
 * - Symbol is unknown in the verified registry for this chain
 * - Address is already a 0x address (still returns result with known/default decimals)
 *
 * @deprecated Use `resolveToken()` for better error messages.
 *   This function is kept for backward compatibility.
 */
export function resolveTokenAddress(
  symbol: string,
  chainId: number
): { address: string; decimals: number } | null {
  const result = resolveToken(symbol, chainId);
  if (result.ok) {
    return { address: result.address, decimals: result.decimals };
  }
  return null;
}

export function formatTokenAmount(amountRaw: string, decimals: number): string {
  if (!amountRaw || amountRaw === "0") return "0";
  const str = amountRaw.padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  const trimmed = fracPart.replace(/0+$/, "").slice(0, 8);
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

export function parseTokenAmount(amount: string, decimals: number): string {
  const [intPart, fracPart = ""] = amount.split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const raw = intPart + padded;
  return raw.replace(/^0+/, "") || "0";
}
