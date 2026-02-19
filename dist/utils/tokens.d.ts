export interface TokenEntry {
    symbol: string;
    name: string;
    decimals: number;
    addresses: Record<number, string>;
}
export declare const COMMON_TOKENS: TokenEntry[];
export declare function resolveTokenAddress(symbol: string, chainId: number): {
    address: string;
    decimals: number;
} | null;
export declare function formatTokenAmount(amountRaw: string, decimals: number): string;
export declare function parseTokenAmount(amount: string, decimals: number): string;
