import { Interface } from "ethers";
import type {
  BridgeBackend,
  BridgeQuote,
  BridgeStatus,
  ChainInfo,
  QuoteParams,
  TokenInfo,
  TransactionRequest,
} from "./types.js";
import { formatTokenAmount } from "../utils/tokens.js";
import { getAllChains } from "../utils/chains.js";
import { buildApproveData, isNativeToken } from "../utils/evm.js";
import { estimateGasCostUsd, getGasUnits } from "../utils/gas-estimator.js";
import { lookupByAddress } from "../utils/token-registry.js";

/** WETH addresses by chain — Across requires WETH address for native ETH bridging */
const WETH_BY_CHAIN: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",     // Ethereum
  10: "0x4200000000000000000000000000000000000006",       // Optimism
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",     // BSC (WBNB)
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",    // Polygon (WMATIC)
  8453: "0x4200000000000000000000000000000000000006",     // Base
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",   // Arbitrum
  43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",   // Avalanche (WAVAX)
  59144: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",   // Linea (WETH)
  534352: "0x5300000000000000000000000000000000000004",    // Scroll (WETH)
  324: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",     // zkSync Era (WETH)
};

/** Across V3 SpokePool depositV3 ABI fragment */
const SPOKE_POOL_ABI = new Interface([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)",
]);

const BASE_URL = "https://app.across.to/api";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Across ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// buildApproveData imported from ../utils/evm.js

// Across V3 SpokePool addresses per chain (NEW-LOW-002)
// These addresses are from Across Protocol V3 deployment.
// Verified: 2025-02-25. If Across upgrades to V4 or redeploys contracts,
// these addresses MUST be updated. Check: https://docs.across.to/reference/contract-addresses
const SPOKE_POOLS: Record<number, string> = {
  1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  59144: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75",
  534352: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
  324: "0xE0B015E54d54fc84a6cB9B666099c46adE3335fF",
};

export class AcrossBackend implements BridgeBackend {
  name = "across";
  private referrer?: string;

  constructor(referrer?: string) {
    this.referrer = referrer;
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      // Across only supports same-token bridging (e.g. USDC→USDC across chains).
      // Skip cross-token swaps — those should go through aggregators like LI.FI.
      // NOTE: We compare by symbol, not address, because the same token (e.g. USDC)
      // has different contract addresses on different chains.
      if (params.fromTokenAddress.toLowerCase() !== params.toTokenAddress.toLowerCase()) {
        const fromToken = lookupByAddress(params.fromTokenAddress, params.fromChainId);
        const toToken = lookupByAddress(params.toTokenAddress, params.toChainId);
        // If both are known tokens with the same symbol, Across can bridge them.
        // If either is unknown or symbols differ, skip — let aggregators handle it.
        if (!fromToken || !toToken || fromToken.symbol !== toToken.symbol) {
          return null;
        }
      }

      // Across uses suggested-fees to get the fee structure for a route
      const url = new URL(`${BASE_URL}/suggested-fees`);
      url.searchParams.set("originChainId", String(params.fromChainId));
      url.searchParams.set("destinationChainId", String(params.toChainId));
      // Across needs WETH address for native tokens
      const isNative = isNativeToken(params.fromTokenAddress);
      const acrossToken = isNative
        ? (WETH_BY_CHAIN[params.fromChainId] ?? params.fromTokenAddress)
        : params.fromTokenAddress;
      url.searchParams.set("token", acrossToken);
      url.searchParams.set("amount", params.amountRaw);
      if (this.referrer) {
        url.searchParams.set("referrer", this.referrer);
      }

      const data = await fetchJson(url.toString());

      if (!data.totalRelayFee) return null;

      const inputBig = BigInt(params.amountRaw);
      const totalFeeBig = BigInt(data.totalRelayFee.total ?? "0");
      const outputBig = inputBig - totalFeeBig;

      if (outputBig <= 0n) return null;

      const outputRaw = outputBig.toString();
      // Use token decimals from the API response if available, fall back to params or registry
      const decimals = data.inputToken?.decimals ?? params.fromTokenDecimals ?? 6;

      // Across doesn't provide USD fee estimates — we get fee in token units.
      // Convert to human-readable token amount. For stablecoins this ≈ USD,
      // for other tokens it's an approximation (would need price oracle for true USD).
      const feeTokenAmount = Number(formatTokenAmount(totalFeeBig.toString(), decimals));
      // Use token amount as fee estimate — close enough for stablecoins,
      // and we label it clearly in the fee breakdown.
      const feeUsd = feeTokenAmount;

      const estimatedFillTime = data.estimatedFillTimeSec ?? 120;

      // Estimate source chain gas cost (chain-aware)
      const gasUnits = getGasUnits("across", params.fromChainId);
      const gasEstimate = await estimateGasCostUsd(params.fromChainId, gasUnits);
      const gasCostUsd = gasEstimate?.costUsd ?? null;

      return {
        backendName: "across",
        provider: "Across (direct)",
        outputAmount: formatTokenAmount(outputRaw, decimals),
        outputAmountRaw: outputRaw,
        // Across is intent-based with deterministic pricing — min = estimated
        minOutputAmount: formatTokenAmount(outputRaw, decimals),
        minOutputAmountRaw: outputRaw,
        outputDecimals: decimals,
        estimatedGasCostUsd: gasCostUsd,
        usingFallbackPrices: gasEstimate?.usingFallbackPrices,
        estimatedFeeUsd: gasCostUsd !== null ? Math.round((feeUsd + gasCostUsd) * 100) / 100 : null,
        feeBreakdown: {
          gasCostUsd,
          protocolFeeUsd: Math.round(feeUsd * 100) / 100,
          integratorFeeUsd: 0,
          integratorFeePercent: null,
          totalFeeUsd: gasCostUsd !== null ? Math.round((feeUsd + gasCostUsd) * 100) / 100 : null,
        },
        estimatedTimeSeconds: estimatedFillTime,
        route: `Across Protocol (fast bridge)`,
        quoteData: {
          fees: data,
          params: {
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            fromTokenAddress: params.fromTokenAddress,
            toTokenAddress: params.toTokenAddress,
            amountRaw: params.amountRaw,
            fromAddress: params.fromAddress,
            toAddress: params.toAddress || params.fromAddress,
            outputRaw,
          },
          spokePool: SPOKE_POOLS[params.fromChainId],
          timestamp: data.timestamp ?? Math.floor(Date.now() / 1000),
          exclusiveRelayer: data.exclusiveRelayer ?? "0x0000000000000000000000000000000000000000",
          exclusivityDeadline: data.exclusivityDeadline ?? 0,
        },
        // Across quotes are based on a specific timestamp. The fee structure
        // is valid for a limited window. Use the shorter of: the API-provided
        // exclusivityDeadline or a conservative 60s default.
        // exclusivityDeadline from the API is a small relative offset (e.g. 5 seconds),
        // NOT an epoch timestamp. Use a conservative 60s TTL for quote validity.
        expiresAt: Date.now() + 60_000,
      };
    } catch (err) {
      console.error("[across] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const p = qd.params;
    const spokePool = qd.spokePool;

    if (!spokePool) {
      throw new Error(`Across: no SpokePool address for chain ${p.fromChainId}`);
    }

        const isNative = isNativeToken(p.fromTokenAddress);

    // Build depositV3 calldata using ethers Interface (V3-LOW-002)
    const calldata = SPOKE_POOL_ABI.encodeFunctionData("depositV3", [
      p.fromAddress,                                                          // depositor
      p.toAddress || p.fromAddress,                                           // recipient
      isNative ? (WETH_BY_CHAIN[p.fromChainId] ?? p.fromTokenAddress) : p.fromTokenAddress, // inputToken (WETH for native)
      isNativeToken(p.toTokenAddress) ? (WETH_BY_CHAIN[p.toChainId] ?? p.toTokenAddress) : p.toTokenAddress, // outputToken (WETH for native)
      BigInt(p.amountRaw),                                                    // inputAmount
      BigInt(p.outputRaw),                                                    // outputAmount
      BigInt(p.toChainId),                                                    // destinationChainId
      qd.exclusiveRelayer ?? "0x0000000000000000000000000000000000000000",     // exclusiveRelayer
      qd.timestamp ?? Math.floor(Date.now() / 1000),                         // quoteTimestamp
      Math.floor(Date.now() / 1000) + 3600,                                  // fillDeadline (1 hour)
      qd.exclusivityDeadline ?? 0,                                            // exclusivityDeadline
      "0x",                                                                   // message (empty)
    ]);

    const result: TransactionRequest = {
      to: spokePool,
      data: calldata,
      value: isNative ? `0x${BigInt(p.amountRaw).toString(16)}` : "0x0",
      chainId: p.fromChainId,
      provider: "across",
      trackingId: `across:${p.fromChainId}:${Date.now()}`,
    };

    // Add approval for ERC20 tokens
    if (!isNative) {
      result.approvalTx = {
        to: p.fromTokenAddress,
        data: buildApproveData(spokePool, p.amountRaw),
        value: "0x0",
        chainId: p.fromChainId,
      };
    }

    return result;
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>
  ): Promise<BridgeStatus> {
    try {
      const txHash = meta?.txHash;
      if (!txHash) {
        return {
          state: "unknown",
          humanReadable: "No transaction hash provided for Across status check",
          provider: "across",
          elapsed: 0,
        };
      }

      const fromChain = meta?.fromChain ?? "1";

      const url = new URL(`${BASE_URL}/deposit/status`);
      url.searchParams.set("originChainId", fromChain);
      url.searchParams.set("depositTxHash", txHash);

      const data = await fetchJson(url.toString());

      const stateMap: Record<string, BridgeStatus["state"]> = {
        pending: "pending",
        filled: "completed",
        expired: "failed",
        slowfill: "in_progress",
      };

      return {
        state: stateMap[data.status] ?? "in_progress",
        humanReadable: `Across bridge: ${data.status ?? "unknown"}`,
        sourceTxHash: txHash,
        destTxHash: data.fillTx,
        provider: "across",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "across",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/available-routes`);
      if (Array.isArray(data)) {
        const chainIds = new Set<number>();
        for (const route of data) {
          if (route.originChainId) chainIds.add(route.originChainId);
          if (route.destinationChainId) chainIds.add(route.destinationChainId);
        }
        const chains = getAllChains();
        return Array.from(chainIds).map((id) => {
          const known = chains.find((c) => c.id === id);
          return {
            id,
            name: known?.name ?? `Chain ${id}`,
            key: known?.key ?? `chain-${id}`,
            providers: ["across"],
          };
        });
      }
    } catch {
      // Fallback
    }
    return Object.keys(SPOKE_POOLS).map((id) => {
      const chains = getAllChains();
      const known = chains.find((c) => c.id === Number(id));
      return {
        id: Number(id),
        name: known?.name ?? `Chain ${id}`,
        key: known?.key ?? `chain-${id}`,
        providers: ["across"],
      };
    });
  }
}
