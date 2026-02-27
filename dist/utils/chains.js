const CHAINS = [
    { id: 1, name: "Ethereum", key: "ethereum" },
    { id: 10, name: "Optimism", key: "optimism" },
    { id: 56, name: "BNB Chain", key: "bsc" },
    { id: 137, name: "Polygon", key: "polygon" },
    { id: 42161, name: "Arbitrum", key: "arbitrum" },
    { id: 43114, name: "Avalanche", key: "avalanche" },
    { id: 8453, name: "Base", key: "base" },
    { id: 59144, name: "Linea", key: "linea" },
    { id: 534352, name: "Scroll", key: "scroll" },
    { id: 324, name: "zkSync Era", key: "zksync" },
    { id: 5000, name: "Mantle", key: "mantle" },
    { id: 81457, name: "Blast", key: "blast" },
    { id: 7777777, name: "Zora", key: "zora" },
    { id: 34443, name: "Mode", key: "mode" },
    // Solana support planned for v2 — requires non-EVM address handling,
    // Solana-specific transaction building, and wallet adapter integration.
];
// Backend-specific chain ID overrides (reserved for future non-EVM chain support)
const CHAIN_ID_OVERRIDES = {};
export function getBackendChainId(backendName, chainId) {
    const key = backendName.toLowerCase().replace(/\s*\(.*\)/, "");
    return CHAIN_ID_OVERRIDES[key]?.[chainId] ?? chainId;
}
export function resolveChainId(input) {
    // Try numeric: only accept chain IDs that are in the known CHAINS array (V3-LOW-003)
    const num = Number(input);
    if (!isNaN(num) && Number.isInteger(num) && num > 0) {
        const known = CHAINS.find((c) => c.id === num);
        return known ? known.id : null;
    }
    const lower = input.toLowerCase().trim();
    const match = CHAINS.find((c) => c.key === lower || c.name.toLowerCase() === lower);
    return match?.id ?? null;
}
export function getChainName(id) {
    return CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}
export function getAllChains() {
    return CHAINS;
}
