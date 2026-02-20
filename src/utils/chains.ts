export interface ChainEntry {
  id: number;
  name: string;
  key: string;
}

const CHAINS: ChainEntry[] = [
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
  { id: 1151111081099710, name: "Solana", key: "solana" },
];

// Backend-specific chain ID overrides (Solana has different IDs per provider)
const CHAIN_ID_OVERRIDES: Record<string, Record<number, number>> = {
  debridge: {
    1151111081099710: 7565164, // deBridge uses 7565164 for Solana
  },
};

export function getBackendChainId(backendName: string, chainId: number): number {
  const key = backendName.toLowerCase().replace(/\s*\(.*\)/, "");
  return CHAIN_ID_OVERRIDES[key]?.[chainId] ?? chainId;
}

export function resolveChainId(input: string): number | null {
  // Accept any positive integer chain ID (not just hardcoded ones)
  const num = Number(input);
  if (!isNaN(num) && Number.isInteger(num) && num > 0) return num;
  const lower = input.toLowerCase().trim();
  const match = CHAINS.find((c) => c.key === lower || c.name.toLowerCase() === lower);
  return match?.id ?? null;
}

export function getChainName(id: number): string {
  return CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}

export function getAllChains(): ChainEntry[] {
  return CHAINS;
}
