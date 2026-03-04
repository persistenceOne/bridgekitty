export interface ChainEntry {
  id: number;
  name: string;
  key: string;
}

// Synthetic chain IDs for non-EVM chains.
// These are high positive integers that won't collide with real EVM chain IDs
// but satisfy the routing engine's requirement for positive integer chain IDs.
export const PERSISTENCE_CHAIN_ID = 9999001;
export const COSMOSHUB_CHAIN_ID = 9999002;

const CHAINS: ChainEntry[] = [
  { id: 1, name: "Ethereum", key: "ethereum" },
  { id: 10, name: "Optimism", key: "optimism" },
  { id: 25, name: "Cronos", key: "cronos" },
  { id: 56, name: "BNB Chain", key: "bsc" },
  { id: 100, name: "Gnosis", key: "gnosis" },
  { id: 122, name: "Fuse", key: "fuse" },
  { id: 130, name: "Unichain", key: "unichain" },
  { id: 137, name: "Polygon", key: "polygon" },
  { id: 143, name: "Monad", key: "monad" },
  { id: 196, name: "X Layer", key: "xlayer" },
  { id: 250, name: "Fantom", key: "fantom" },
  { id: 252, name: "Fraxtal", key: "fraxtal" },
  { id: 288, name: "Boba", key: "boba" },
  { id: 324, name: "zkSync Era", key: "zksync" },
  { id: 480, name: "World Chain", key: "world-chain" },
  { id: 690, name: "Redstone", key: "redstone" },
  { id: 1088, name: "Metis", key: "metis" },
  { id: 1101, name: "Polygon zkEVM", key: "polygon-zkevm" },
  { id: 1135, name: "Lisk", key: "lisk" },
  { id: 1284, name: "Moonbeam", key: "moonbeam" },
  { id: 1329, name: "Sei", key: "sei" },
  { id: 1625, name: "Gravity", key: "gravity" },
  { id: 1868, name: "Soneium", key: "soneium" },
  { id: 1923, name: "Swellchain", key: "swellchain" },
  { id: 2741, name: "Abstract", key: "abstract" },
  { id: 5000, name: "Mantle", key: "mantle" },
  { id: 7560, name: "Cyber", key: "cyber" },
  { id: 7777777, name: "Zora", key: "zora" },
  { id: 8453, name: "Base", key: "base" },
  { id: 13371, name: "Immutable zkEVM", key: "immutable-zkevm" },
  { id: 17000, name: "Holesky", key: "holesky" },
  { id: 30, name: "Rootstock", key: "rootstock" },
  { id: 33139, name: "ApeChain", key: "apechain" },
  { id: 34443, name: "Mode", key: "mode" },
  { id: 42161, name: "Arbitrum", key: "arbitrum" },
  { id: 42170, name: "Arbitrum Nova", key: "arbitrum-nova" },
  { id: 42220, name: "Celo", key: "celo" },
  { id: 43114, name: "Avalanche", key: "avalanche" },
  { id: 44787, name: "Celo Alfajores", key: "celo-alfajores" },
  { id: 57073, name: "Ink", key: "ink" },
  { id: 59144, name: "Linea", key: "linea" },
  { id: 60808, name: "Bob", key: "bob" },
  { id: 81457, name: "Blast", key: "blast" },
  { id: 146, name: "Sonic", key: "sonic" },
  { id: 167000, name: "Taiko", key: "taiko" },
  { id: 2020, name: "Ronin", key: "ronin" },
  { id: 204, name: "opBNB", key: "opbnb" },
  { id: 534352, name: "Scroll", key: "scroll" },
  { id: 7225878, name: "Saakuru", key: "saakuru" },
  { id: 666666666, name: "Degen", key: "degen" },
  { id: 80094, name: "Berachain", key: "berachain" },
  { id: 50104, name: "Sophon", key: "sophon" },
  { id: 37714555429, name: "Xai", key: "xai" },
  { id: 14, name: "Flare", key: "flare" },
  { id: 1516, name: "Story", key: "story" },
  { id: 4801, name: "World Chain Testnet", key: "world-chain-testnet" },
  { id: 8217, name: "Kaia", key: "kaia" },
  { id: 1750, name: "Metal L2", key: "metal" },
  { id: 2522, name: "Shadow", key: "shadow" },
  { id: 98865, name: "Plume", key: "plume" },
  { id: 21000000, name: "Corn", key: "corn" },
  { id: 232, name: "Lens", key: "lens" },
  { id: 999, name: "HyperEVM", key: "hyperevm" },
  { id: 360, name: "Shape", key: "shape" },
  { id: 1514, name: "Hemi", key: "hemi" },
  { id: 810180, name: "zkLink Nova", key: "zklink-nova" },
  { id: 4326, name: "MegaETH", key: "megaeth" },
  { id: 9745, name: "Plasma", key: "plasma" },
  // Cosmos chains (synthetic IDs — mapped to real chain ID strings by Squid backend)
  { id: PERSISTENCE_CHAIN_ID, name: "Persistence", key: "persistence" },
  { id: COSMOSHUB_CHAIN_ID, name: "Cosmos Hub", key: "cosmoshub" },
];

// Backend-specific chain ID overrides (reserved for future non-EVM chain support)
const CHAIN_ID_OVERRIDES: Record<string, Record<number, number>> = {};

export function getBackendChainId(backendName: string, chainId: number): number {
  const key = backendName.toLowerCase().replace(/\s*\(.*\)/, "");
  return CHAIN_ID_OVERRIDES[key]?.[chainId] ?? chainId;
}

// Mapping from chain key → real Cosmos chain ID string (for Squid Router / IBC)
export const COSMOS_CHAIN_IDS: Record<string, string> = {
  persistence: "core-1",
  cosmoshub: "cosmoshub-4",
};

// Reverse mapping: synthetic numeric ID → Cosmos chain ID string (as used by Squid Router)
export const SYNTHETIC_TO_COSMOS: Record<number, string> = {
  [PERSISTENCE_CHAIN_ID]: "core-1",
  [COSMOSHUB_CHAIN_ID]: "cosmoshub-4",
};

export function resolveChainId(input: string): number | null {
  // Try numeric: only accept chain IDs that are in the known CHAINS array (V3-LOW-003)
  const num = Number(input);
  if (!isNaN(num) && Number.isInteger(num) && num > 0) {
    const known = CHAINS.find((c) => c.id === num);
    return known ? known.id : null;
  }
  // Also accept Cosmos chain ID strings directly (e.g. "core-1", "cosmoshub-4")
  const lower = input.toLowerCase().trim();
  for (const [syntheticId, cosmosId] of Object.entries(SYNTHETIC_TO_COSMOS)) {
    if (lower === cosmosId || lower === cosmosId.replace(/-/g, "")) {
      return Number(syntheticId);
    }
  }
  // Also accept common aliases for Cosmos chains
  if (lower === "persistence-core-1" || lower === "persistencecore1") {
    return PERSISTENCE_CHAIN_ID;
  }
  if (lower === "cosmoshub4") {
    return COSMOSHUB_CHAIN_ID;
  }
  const match = CHAINS.find((c) => c.key === lower || c.name.toLowerCase() === lower);
  return match?.id ?? null;
}

/** Check if a chain key or ID refers to a Cosmos chain */
export function isCosmosChain(chainKeyOrId: string | number): boolean {
  if (typeof chainKeyOrId === "number") {
    return SYNTHETIC_TO_COSMOS[chainKeyOrId] !== undefined;
  }
  return COSMOS_CHAIN_IDS[chainKeyOrId.toLowerCase()] !== undefined;
}

/** Get the Cosmos chain ID string for Squid Router from a synthetic numeric ID */
export function getCosmosChainIdFromSynthetic(syntheticId: number): string | null {
  return SYNTHETIC_TO_COSMOS[syntheticId] ?? null;
}

/** Get the Cosmos chain ID string from a chain key */
export function getCosmosChainId(key: string): string | null {
  return COSMOS_CHAIN_IDS[key.toLowerCase()] ?? null;
}

export function getChainName(id: number): string {
  return CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}

export function getAllChains(): ChainEntry[] {
  return CHAINS;
}
