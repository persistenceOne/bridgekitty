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
export declare function resolveTokenAddress(symbol: string, chainId: number): {
    address: string;
    decimals: number;
} | null;
export declare function formatTokenAmount(amountRaw: string, decimals: number): string;
export declare function parseTokenAmount(amount: string, decimals: number): string;
