/**
 * Gas cost estimator for backends that don't provide gas fee estimates.
 * Uses chain-aware gas unit estimates + live gas price + native token USD price.
 *
 * Strategy:
 * 1. Chain-aware gas units per backend type (L1 vs L2 differentiation)
 * 2. Live gas price via eth_gasPrice RPC (cached 30s)
 * 3. Native token USD price via LI.FI /v1/token or hardcoded fallback (cached 5min)
 * 4. Calculate: gasUnits × gasPrice × nativeTokenPriceUSD
 * 5. If we can't reliably estimate → return null (displayed as "unknown")
 */

const GAS_PRICE_CACHE_TTL_MS = 30_000; // 30 seconds
const TOKEN_PRICE_CACHE_TTL_MS = 300_000; // 5 minutes
const RPC_TIMEOUT_MS = 5_000;
const LIFI_TIMEOUT_MS = 5_000;

// Chain ID → env var name mapping for RPC overrides
const CHAIN_RPC_ENV_KEYS: Record<number, string> = {
  1: "RPC_ETHEREUM",
  10: "RPC_OPTIMISM",
  56: "RPC_BSC",
  137: "RPC_POLYGON",
  42161: "RPC_ARBITRUM",
  43114: "RPC_AVALANCHE",
  8453: "RPC_BASE",
  59144: "RPC_LINEA",
  534352: "RPC_SCROLL",
  324: "RPC_ZKSYNC",
  5000: "RPC_MANTLE",
  81457: "RPC_BLAST",
};

// Default public RPCs per chain with failover (used when env var not set)
// Multiple endpoints per chain for reliability — tried in order on failure.
const DEFAULT_CHAIN_RPCS: Record<number, string[]> = {
  1: ["https://rpc.ankr.com/eth", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  10: ["https://rpc.ankr.com/optimism", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  56: ["https://rpc.ankr.com/bsc", "https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"],
  137: ["https://rpc.ankr.com/polygon", "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  42161: ["https://rpc.ankr.com/arbitrum", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  43114: ["https://rpc.ankr.com/avalanche", "https://avalanche-c-chain-rpc.publicnode.com"],
  8453: ["https://rpc.ankr.com/base", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  59144: ["https://rpc.ankr.com/linea", "https://linea-rpc.publicnode.com"],
  534352: ["https://rpc.ankr.com/scroll", "https://scroll-rpc.publicnode.com"],
  324: ["https://rpc.ankr.com/zksync_era", "https://zksync-era-rpc.publicnode.com"],
  5000: ["https://rpc.ankr.com/mantle", "https://mantle-rpc.publicnode.com"],
  81457: ["https://rpc.ankr.com/blast", "https://blast-rpc.publicnode.com"],
};

/** M-3: Validate that an RPC URL uses HTTPS (except localhost) */
function validateRpcUrl(url: string): string {
  if (url.startsWith("https://")) return url;
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) return url;
  throw new Error(`Insecure RPC URL rejected: only HTTPS URLs are allowed (got ${url.split("/").slice(0, 3).join("/")})`);
}

/** Resolve RPC URLs for a chain: env var override → default RPCs with failover */
export function getChainRpcUrls(chainId: number): string[] {
  const envKey = CHAIN_RPC_ENV_KEYS[chainId];
  if (envKey && process.env[envKey]) {
    return [validateRpcUrl(process.env[envKey]!)];
  }
  const defaults = DEFAULT_CHAIN_RPCS[chainId];
  return defaults ? defaults.map(validateRpcUrl) : [];
}

/** Resolve primary RPC URL for a chain (backward compat) */
export function getChainRpcUrl(chainId: number): string | undefined {
  const urls = getChainRpcUrls(chainId);
  return urls.length > 0 ? urls[0] : undefined;
}

// Native token address (used by LI.FI) — zero address for EVM chains
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

// Fallback gas prices in gwei (conservative estimates if RPC fails)
const FALLBACK_GAS_PRICE_GWEI: Record<number, number> = {
  1: 30,      // Ethereum mainnet
  10: 0.05,   // Optimism (L2, very cheap)
  56: 3,      // BSC
  137: 50,    // Polygon
  42161: 0.1, // Arbitrum (L2)
  43114: 30,  // Avalanche
  8453: 0.05, // Base (L2)
  59144: 0.1, // Linea (L2)
  534352: 0.1,// Scroll (L2)
  324: 0.25,  // zkSync
  5000: 0.05, // Mantle (L2)
  81457: 0.05,// Blast (L2)
};

// L-4: Fallback native token USD prices — STALE DATA, used only when LI.FI API is unreachable.
// Last updated: 2026-02-26. These values drift significantly; live prices are always preferred.
const FALLBACK_NATIVE_PRICE_USD: Record<number, number> = {
  1: 1850,     // ETH
  10: 1850,    // ETH (Optimism)
  56: 600,     // BNB
  137: 0.50,   // MATIC/POL
  42161: 1850, // ETH (Arbitrum)
  43114: 35,   // AVAX
  8453: 1850,  // ETH (Base)
  59144: 1850, // ETH (Linea)
  534352: 1850,// ETH (Scroll)
  324: 1850,   // ETH (zkSync)
  5000: 1850,  // MNT (Mantle)
  81457: 1850, // ETH (Blast)
};

// Ethereum mainnet chain ID
const ETH_MAINNET = 1;

// Caches
const gasPriceCache = new Map<number, { priceWei: bigint; fetchedAt: number }>();
const nativePriceCache = new Map<number, { priceUsd: number; fetchedAt: number }>();

/**
 * Get estimated gas units for a backend's source chain transaction.
 * Returns null if we can't reliably estimate (unknown backend or chain).
 *
 * These are estimates for the USER's on-chain transaction:
 * - deBridge: createOrder (~65k on L2/BSC, ~150k on ETH mainnet)
 * - Across: depositV3 (~65k on L2/BSC, ~120k on ETH mainnet)
 * - Persistence: approve + escrow (~80k, only Base/BSC)
 */
export function getGasUnits(backend: string, chainId: number): number | null {
  switch (backend) {
    case "debridge":
      return chainId === ETH_MAINNET ? 150_000 : 65_000;
    case "across":
      return chainId === ETH_MAINNET ? 120_000 : 65_000;
    case "relay":
      return chainId === ETH_MAINNET ? 130_000 : 65_000;
    case "skip":
      return chainId === ETH_MAINNET ? 150_000 : 80_000;
    case "persistence":
      // Only supports Base (8453) and BSC (56)
      if (chainId === 8453 || chainId === 56) return 80_000;
      return null;
    default:
      return null; // Unknown backend — can't estimate
  }
}

/**
 * Fetch gas price (in wei) from an EVM RPC node.
 * Returns cached value if still fresh. Returns null on total failure
 * for unknown chains (no RPC and no fallback).
 */
async function getGasPriceWei(chainId: number): Promise<{ priceWei: bigint; isFallback: boolean } | null> {
  const now = Date.now();

  // Check cache
  const cached = gasPriceCache.get(chainId);
  if (cached && now - cached.fetchedAt < GAS_PRICE_CACHE_TTL_MS) {
    return { priceWei: cached.priceWei, isFallback: false };
  }

  const rpcUrls = getChainRpcUrls(chainId);
  if (rpcUrls.length === 0) {
    // No RPC configured — use fallback if available
    const fallbackGwei = FALLBACK_GAS_PRICE_GWEI[chainId];
    if (fallbackGwei === undefined) return null; // Truly unknown chain
    return { priceWei: BigInt(Math.round(fallbackGwei * 1e9)), isFallback: true };
  }

  // Try each RPC in order until one succeeds
  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_gasPrice",
          params: [],
          id: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) throw new Error(`RPC ${res.status}`);

      const data = await res.json();
      const hexPrice = data.result;
      if (!hexPrice) throw new Error("No result from eth_gasPrice");

      const priceWei = BigInt(hexPrice);

      // Cache it
      gasPriceCache.set(chainId, { priceWei, fetchedAt: now });

      return { priceWei, isFallback: false };
    } catch (err) {
      lastError = err as Error;
      // Try next RPC
    }
  }

  console.error(`[gas-estimator] eth_gasPrice failed for chain ${chainId} (tried ${rpcUrls.length} RPCs):`, lastError?.message);
  // All RPCs failed — use fallback
  const fallbackGwei = FALLBACK_GAS_PRICE_GWEI[chainId];
  if (fallbackGwei === undefined) return null;
  return { priceWei: BigInt(Math.round(fallbackGwei * 1e9)), isFallback: true };
}

/**
 * Fetch native token USD price via LI.FI /v1/token endpoint.
 * Falls back to hardcoded prices on failure. Returns null for unknown chains.
 * Returns { priceUsd, isFallback } to indicate data freshness.
 */
async function getNativeTokenPriceUsd(chainId: number): Promise<{ priceUsd: number; isFallback: boolean } | null> {
  const now = Date.now();

  // Check cache
  const cached = nativePriceCache.get(chainId);
  if (cached && now - cached.fetchedAt < TOKEN_PRICE_CACHE_TTL_MS) {
    return { priceUsd: cached.priceUsd, isFallback: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIFI_TIMEOUT_MS);

    const url = `https://li.quest/v1/token?chain=${chainId}&token=${NATIVE_TOKEN_ADDRESS}`;
    const res = await fetch(url, { signal: controller.signal });

    clearTimeout(timer);

    if (!res.ok) throw new Error(`LI.FI token ${res.status}`);

    const data = await res.json();
    const priceUsd = data.priceUSD ? parseFloat(data.priceUSD) : 0;

    if (priceUsd > 0) {
      nativePriceCache.set(chainId, { priceUsd, fetchedAt: now });
      return { priceUsd, isFallback: false };
    }

    throw new Error("No price returned");
  } catch (err) {
    console.error(`[gas-estimator] LI.FI token price failed for chain ${chainId}:`, (err as Error).message);
    // Fallback to hardcoded
    const fallback = FALLBACK_NATIVE_PRICE_USD[chainId];
    if (fallback === undefined) return null; // Truly unknown chain
    // Still cache the fallback briefly to avoid hammering a failing endpoint
    nativePriceCache.set(chainId, { priceUsd: fallback, fetchedAt: now });
    return { priceUsd: fallback, isFallback: true };
  }
}

/** Result of gas cost estimation with staleness indicator */
export interface GasCostEstimate {
  /** Estimated gas cost in USD */
  costUsd: number;
  /** True if fallback (hardcoded) prices were used instead of live data */
  usingFallbackPrices: boolean;
}

/**
 * Estimate gas cost in USD for a transaction on the given chain.
 *
 * @param chainId - EVM chain ID
 * @param gasUnits - Estimated gas units for the transaction, or null if unknown
 * @returns Estimated cost with staleness indicator, or null if we can't estimate
 */
export async function estimateGasCostUsd(
  chainId: number,
  gasUnits: number | null
): Promise<GasCostEstimate | null> {
  // If gas units are unknown, we can't estimate
  if (gasUnits === null) return null;

  try {
    const [gasPriceResult, nativePriceResult] = await Promise.all([
      getGasPriceWei(chainId),
      getNativeTokenPriceUsd(chainId),
    ]);

    // If either lookup failed completely, return null
    if (gasPriceResult === null || nativePriceResult === null) return null;

    const usingFallbackPrices = gasPriceResult.isFallback || nativePriceResult.isFallback;

    // gasCost in ETH = gasUnits * gasPriceWei / 1e18
    // gasCost in USD = gasCost in ETH * nativePriceUsd
    const gasCostWei = BigInt(gasUnits) * gasPriceResult.priceWei;
    // (NEW-LOW-001) Divide in BigInt first to keep intermediate values within safe Number range
    const gasCostEth = Number(gasCostWei / 10n**9n) / 1e9;
    const gasCostUsd = gasCostEth * nativePriceResult.priceUsd;

    // Round to 2 decimal places
    return {
      costUsd: Math.round(gasCostUsd * 100) / 100,
      usingFallbackPrices,
    };
  } catch (err) {
    console.error(`[gas-estimator] estimation failed for chain ${chainId}:`, (err as Error).message);
    // Can't estimate — return null instead of a misleading 0
    return null;
  }
}
