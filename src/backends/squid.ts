import type {
  BridgeBackend,
  BridgeQuote,
  BridgeStatus,
  ChainInfo,
  FeeBreakdown,
  QuoteParams,
  TokenInfo,
  TransactionRequest,
} from "./types.js";
import { formatTokenAmount } from "../utils/tokens.js";
import { buildApproveData, isNativeToken } from "../utils/evm.js";
import { estimateGasCostUsd, getGasUnits } from "../utils/gas-estimator.js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { getCosmosChainIdFromSynthetic, isCosmosChain, PERSISTENCE_CHAIN_ID, COSMOSHUB_CHAIN_ID } from "../utils/chains.js";
import { getKey } from "../tools/wallet.js";

// Cosmos bech32 prefixes by synthetic chain ID
const COSMOS_BECH32_PREFIX: Record<number, string> = {
  [PERSISTENCE_CHAIN_ID]: "persistence",
  [COSMOSHUB_CHAIN_ID]: "cosmos",
};

// Valid placeholder addresses for quote-only requests (derived from well-known "abandon" mnemonic)
const COSMOS_PLACEHOLDER_ADDRESS: Record<number, string> = {
  [PERSISTENCE_CHAIN_ID]: "persistence19rl4cm2hmr8afy4kldpxz3fka4jguq0ajvtw33",
  [COSMOSHUB_CHAIN_ID]: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
};

const BASE_URL = "https://v2.api.squidrouter.com";
const TIMEOUT_MS = 15_000;

/**
 * Convert native token address from zero address to EVM sentinel address for Squid API.
 * Squid rejects 0x0000...0000 and requires 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native tokens.
 */
function convertNativeTokenForSquid(tokenAddress: string): string {
  if (tokenAddress === "0x0000000000000000000000000000000000000000") {
    return "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  }
  return tokenAddress;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Squid ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class SquidBackend implements BridgeBackend {
  name = "squid";
  private integratorId?: string;

  constructor(integratorId?: string) {
    this.integratorId = integratorId;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.integratorId) {
      h["x-integrator-id"] = this.integratorId;
    }
    return h;
  }

  /**
   * Map a chain ID to the string Squid Router expects.
   * For EVM chains, this is just the numeric string (e.g. "8453").
   * For Cosmos chains, this is the Cosmos chain ID string (e.g. "persistence-core-1").
   */
  private resolveSquidChainId(chainId: number): string {
    const cosmosId = getCosmosChainIdFromSynthetic(chainId);
    return cosmosId ?? String(chainId);
  }

  /**
   * Resolve the recipient address for a Cosmos destination chain.
   * If the provided toAddress is an EVM address (0x...), derive the
   * Cosmos bech32 address from the wallet mnemonic.
   * Falls back to a placeholder for quote-only requests.
   */
  private async resolveCosmosToAddress(
    toAddress: string | undefined,
    toChainId: number,
    forExecution: boolean
  ): Promise<string> {
    // If already a bech32 Cosmos address, use it directly
    if (toAddress && !toAddress.startsWith("0x")) {
      return toAddress;
    }

    // Try to derive from wallet mnemonic
    const mnemonic = getKey("mnemonic");
    const prefix = COSMOS_BECH32_PREFIX[toChainId];
    if (mnemonic && prefix) {
      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
        const [account] = await wallet.getAccounts();
        return account.address;
      } catch {
        // Fall through to placeholder
      }
    }

    if (forExecution) {
      throw new Error(
        `Cosmos destination requires a valid bech32 address (e.g. ${prefix || "cosmos"}1...). ` +
        `Configure a wallet with wallet_setup to auto-derive, or pass toAddress explicitly.`
      );
    }

    // For quoting, use a valid placeholder address — Squid validates bech32 checksums
    // but the quote amount doesn't depend on the specific address
    const placeholder = COSMOS_PLACEHOLDER_ADDRESS[toChainId];
    if (placeholder) return placeholder;
    return `${prefix || "cosmos"}1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0wejkl`;
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const fromChainStr = this.resolveSquidChainId(params.fromChainId);
      const toChainStr = this.resolveSquidChainId(params.toChainId);

      // Resolve toAddress for Cosmos destinations
      const toIsCosmos = isCosmosChain(params.toChainId);
      let resolvedToAddress = params.toAddress || params.fromAddress;
      if (toIsCosmos) {
        resolvedToAddress = await this.resolveCosmosToAddress(
          params.toAddress, params.toChainId, false
        );
      }

      const fromIsCosmos = isCosmosChain(params.fromChainId);

      const body: Record<string, any> = {
        fromChain: fromChainStr,
        toChain: toChainStr,
        fromToken: convertNativeTokenForSquid(params.fromTokenAddress),
        toToken: convertNativeTokenForSquid(params.toTokenAddress),
        fromAmount: params.amountRaw,
        fromAddress: params.fromAddress,
        toAddress: resolvedToAddress,
        slippageConfig: {
          autoMode: 1, // 1 = normal auto-slippage
        },
      };

      // Note: "prefer" field removed — Squid v2 API rejects it for many route types
      // ("speed invalid dex" / "output invalid dex"). Squid auto-selects optimal routing.

      const data = await fetchJson(`${BASE_URL}/v2/route`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      const route = data.route;
      if (!route) return null;

      const estimate = route.estimate;
      if (!estimate) return null;

      // Extract output amounts
      const toAmount = estimate.toAmount ?? "0";
      const toAmountMin = estimate.toAmountMin ?? toAmount;
      const toToken = estimate.toToken ?? {};
      const fromToken = estimate.fromToken ?? {};
      const outputDecimals = toToken.decimals ?? params.toTokenDecimals ?? 18;
      const srcSymbol = fromToken.symbol ?? "?";
      const dstSymbol = toToken.symbol ?? "?";

      // Fee breakdown from estimate
      const gasCosts = estimate.gasCosts ?? [];
      let gasCostUsd = 0;
      for (const gc of gasCosts) {
        gasCostUsd += Number(gc.amountUsd ?? gc.amountUSD ?? 0);
      }

      const feeCosts = estimate.feeCosts ?? [];
      let protocolFeeUsd = 0;
      let integratorFeeUsd = 0;
      for (const fc of feeCosts) {
        const usd = Number(fc.amountUsd ?? fc.amountUSD ?? 0);
        if (fc.name?.toLowerCase().includes("integrator") ||
            fc.name?.toLowerCase().includes("affiliate")) {
          integratorFeeUsd += usd;
        } else {
          protocolFeeUsd += usd;
        }
      }

      // If API didn't provide USD gas cost, estimate it ourselves
      if (gasCostUsd < 0.001) {
        const gasUnits = getGasUnits("squid", params.fromChainId);
        if (gasUnits) {
          const gasEstimate = await estimateGasCostUsd(params.fromChainId, gasUnits);
          if (gasEstimate) {
            gasCostUsd = gasEstimate.costUsd;
          }
        }
      }

      const totalFeeUsd = gasCostUsd + protocolFeeUsd + integratorFeeUsd;

      const feeBreakdown: FeeBreakdown = {
        gasCostUsd: gasCostUsd > 0 ? Math.round(gasCostUsd * 100) / 100 : null,
        protocolFeeUsd: Math.round(protocolFeeUsd * 100) / 100,
        integratorFeeUsd: Math.round(integratorFeeUsd * 100) / 100,
        integratorFeePercent: null,
        totalFeeUsd: gasCostUsd > 0 ? Math.round(totalFeeUsd * 100) / 100 : null,
      };

      // Estimated time -- Squid provides estimatedRouteDuration in seconds
      const estimatedTimeSeconds = estimate.estimatedRouteDuration ?? estimate.estimatedTime ?? 300;

      // Build route description from actions/steps
      const actions = estimate.actions ?? [];
      const routeDescription = actions.length > 0
        ? actions
            .map((a: any) => a.provider ?? a.type ?? "?")
            .join(" -> ")
        : "Squid Router";

      return {
        backendName: "squid",
        provider: `${routeDescription} via Squid`,
        outputAmount: formatTokenAmount(toAmount, outputDecimals),
        outputAmountRaw: toAmount,
        minOutputAmount: formatTokenAmount(toAmountMin, outputDecimals),
        minOutputAmountRaw: toAmountMin,
        outputDecimals,
        estimatedGasCostUsd: gasCostUsd > 0 ? Math.round(gasCostUsd * 100) / 100 : null,
        estimatedFeeUsd: gasCostUsd > 0 ? Math.round(totalFeeUsd * 100) / 100 : null,
        feeBreakdown,
        estimatedTimeSeconds,
        route: `${srcSymbol} -> Squid Router -> ${dstSymbol}`,
        quoteData: {
          route: data.route,
          requestId: data.requestId,
          params: {
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            fromTokenAddress: params.fromTokenAddress,
            toTokenAddress: params.toTokenAddress,
            amountRaw: params.amountRaw,
            fromAddress: params.fromAddress,
            toAddress: resolvedToAddress,
          },
        },
        // Squid quotes are relatively stable -- use 60s expiry
        expiresAt: Date.now() + 60_000,
      };
    } catch (err) {
      console.error("[squid] route error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const route = qd.route;
    const p = qd.params;

    if (!route) {
      throw new Error("No route data in Squid quote");
    }

    // Squid V2 includes transactionRequest directly in the route response
    const txReq = route.transactionRequest;
    if (!txReq || !txReq.target || !txReq.data) {
      // If transactionRequest is missing, re-fetch the route to get fresh tx data
      const body: Record<string, any> = {
        fromChain: this.resolveSquidChainId(p.fromChainId),
        toChain: this.resolveSquidChainId(p.toChainId),
        fromToken: convertNativeTokenForSquid(p.fromTokenAddress),
        toToken: convertNativeTokenForSquid(p.toTokenAddress),
        fromAmount: p.amountRaw,
        fromAddress: p.fromAddress,
        toAddress: p.toAddress,
        slippageConfig: {
          autoMode: 1,
        },
      };

      const data = await fetchJson(`${BASE_URL}/v2/route`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      const freshTx = data.route?.transactionRequest;
      if (!freshTx || !freshTx.target || !freshTx.data) {
        throw new Error("No transactionRequest in Squid route response");
      }

      return this.buildTxResult(freshTx, p, data.requestId);
    }

    return this.buildTxResult(txReq, p, qd.requestId);
  }

  private buildTxResult(
    txReq: any,
    params: any,
    requestId?: string
  ): TransactionRequest {
    const result: TransactionRequest = {
      // Squid V2 uses "target" instead of "to" in transactionRequest
      to: txReq.target ?? txReq.to,
      data: txReq.data,
      value: txReq.value ? `0x${BigInt(txReq.value).toString(16)}` : "0x0",
      chainId: Number(txReq.chainId ?? params.fromChainId),
      gasLimit: txReq.gasLimit?.toString(),
      provider: "squid",
      trackingId: `squid:${requestId ?? Date.now()}`,
    };

    // Check if ERC20 approval is needed (non-native tokens)
    if (!isNativeToken(params.fromTokenAddress)) {
      // Squid provides the approval target (router contract address)
      const approvalTarget = txReq.target ?? txReq.to;
      if (approvalTarget) {
        // MEDIUM-001: Cap approval to 110% of quoted input to prevent excessive approvals
        let approvalAmount = params.amountRaw;
        try {
          const inputBn = BigInt(params.amountRaw);
          approvalAmount = ((inputBn * 110n) / 100n).toString();
        } catch {
          // Keep original amount if BigInt conversion fails
        }

        result.approvalTx = {
          to: params.fromTokenAddress,
          data: buildApproveData(approvalTarget, approvalAmount),
          value: "0x0",
          chainId: Number(txReq.chainId ?? params.fromChainId),
        };
      }
    }

    return result;
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>
  ): Promise<BridgeStatus> {
    try {
      const txHash = meta?.txHash;

      // Extract requestId from trackingId ("squid:<requestId>")
      const requestId = trackingId.startsWith("squid:")
        ? trackingId.slice("squid:".length)
        : undefined;

      if (!requestId && !txHash) {
        return {
          state: "unknown",
          humanReadable: "No requestId or txHash for Squid status check",
          provider: "squid",
          elapsed: 0,
        };
      }

      // Build status query params
      const url = new URL(`${BASE_URL}/v2/status`);
      if (txHash) {
        url.searchParams.set("transactionId", txHash);
      }
      if (requestId && requestId !== String(Number(requestId))) {
        // Only use requestId if it looks like a real ID (not a timestamp fallback)
        url.searchParams.set("requestId", requestId);
      }
      if (meta?.fromChain) {
        url.searchParams.set("fromChainId", meta.fromChain);
      }
      if (meta?.toChain) {
        url.searchParams.set("toChainId", meta.toChain);
      }

      const data = await fetchJson(url.toString(), {
        headers: this.headers(),
      });

      // Squid V2 status states
      const stateMap: Record<string, BridgeStatus["state"]> = {
        not_found: "pending",
        ongoing: "in_progress",
        partial_success: "in_progress",
        success: "completed",
        needs_gas: "in_progress",
        confirmed: "completed",
        express_executed: "completed",
        executed: "completed",
        error: "failed",
        refunded: "refunded",
      };

      // Normalize status string (Squid may return uppercase or mixed case)
      const rawStatus = (data.squidTransactionStatus ?? data.status ?? "unknown").toLowerCase();
      const mappedState = stateMap[rawStatus];

      if (!mappedState && rawStatus !== "unknown") {
        console.warn(`[squid] unmapped status: "${rawStatus}" -- treating as in_progress`);
      }

      const elapsed = data.fromChain?.transactionTimestamp
        ? Math.floor((Date.now() - new Date(data.fromChain.transactionTimestamp).getTime()) / 1000)
        : 0;

      return {
        state: mappedState ?? (rawStatus === "unknown" ? "unknown" : "in_progress"),
        humanReadable: `Squid bridge: ${rawStatus}`,
        sourceTxHash: txHash ?? data.fromChain?.transactionId,
        destTxHash: data.toChain?.transactionId,
        provider: "squid",
        elapsed,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${sanitizeError(err as Error)}`,
        provider: "squid",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/v2/chains`, {
        headers: this.headers(),
      });

      const chains: any[] = data.chains ?? [];
      if (chains.length === 0) return this.fallbackChains();

      const result = chains.map((c: any) => {
        const rawId = String(c.chainId);
        // Map known Cosmos chain ID strings to our synthetic numeric IDs
        let numericId: number;
        if (rawId === "core-1") {
          numericId = PERSISTENCE_CHAIN_ID;
        } else if (rawId === "cosmoshub-4") {
          numericId = COSMOSHUB_CHAIN_ID;
        } else if (isNaN(Number(rawId))) {
          // Other Cosmos chains — skip for now (not in our chain registry)
          numericId = NaN;
        } else {
          numericId = Number(rawId);
        }

        // Resolve proper name for known Cosmos chains
        let name = c.chainName ?? c.networkName ?? `Chain ${c.chainId}`;
        if (rawId === "core-1") name = "Persistence";
        else if (rawId === "cosmoshub-4") name = "Cosmos Hub";

        let key = (name).toLowerCase().replace(/\s+/g, "-");
        if (rawId === "core-1") key = "persistence";
        else if (rawId === "cosmoshub-4") key = "cosmoshub";

        return {
          id: numericId,
          name,
          key,
          logoURI: c.chainIconURI ?? c.iconUrl,
          providers: ["squid"],
        };
      }).filter(c => !isNaN(c.id)); // Filter out unmapped Cosmos chains

      return result;
    } catch (err) {
      console.error("[squid] chains error:", (err as Error).message);
      return this.fallbackChains();
    }
  }

  async getSupportedTokens(chainId: number): Promise<TokenInfo[]> {
    try {
      // Convert synthetic chain ID to the string Squid expects
      const squidChainId = this.resolveSquidChainId(chainId);

      const data = await fetchJson(`${BASE_URL}/v2/tokens`, {
        headers: this.headers(),
      });

      const tokens: any[] = data.tokens ?? [];

      // Filter to requested chain (compare as strings since Cosmos chain IDs are strings)
      const chainTokens = tokens.filter(
        (t: any) => String(t.chainId) === squidChainId
      );

      return chainTokens.slice(0, 50).map((t: any) => ({
        symbol: t.symbol,
        name: t.name ?? t.symbol,
        address: t.address,
        decimals: t.decimals,
        chainId: chainId, // Return our synthetic ID, not Squid's string
        logoURI: t.logoURI ?? t.iconUrl,
      }));
    } catch (err) {
      console.error("[squid] tokens error:", (err as Error).message);
      return [];
    }
  }

  /**
   * Fallback chain list when the API is unavailable.
   * Squid supports EVM chains and Cosmos chains (via Axelar GMP).
   */
  private fallbackChains(): ChainInfo[] {
    return [
      { id: 1, name: "Ethereum", key: "ethereum", providers: ["squid"] },
      { id: 10, name: "Optimism", key: "optimism", providers: ["squid"] },
      { id: 56, name: "BNB Chain", key: "bsc", providers: ["squid"] },
      { id: 137, name: "Polygon", key: "polygon", providers: ["squid"] },
      { id: 42161, name: "Arbitrum", key: "arbitrum", providers: ["squid"] },
      { id: 43114, name: "Avalanche", key: "avalanche", providers: ["squid"] },
      { id: 8453, name: "Base", key: "base", providers: ["squid"] },
      { id: 59144, name: "Linea", key: "linea", providers: ["squid"] },
      { id: 534352, name: "Scroll", key: "scroll", providers: ["squid"] },
      { id: 5000, name: "Mantle", key: "mantle", providers: ["squid"] },
      { id: 81457, name: "Blast", key: "blast", providers: ["squid"] },
      { id: 250, name: "Fantom", key: "fantom", providers: ["squid"] },
      { id: 1284, name: "Moonbeam", key: "moonbeam", providers: ["squid"] },
      { id: 2222, name: "Kava", key: "kava", providers: ["squid"] },
      { id: 314, name: "Filecoin", key: "filecoin", providers: ["squid"] },
      { id: 42220, name: "Celo", key: "celo", providers: ["squid"] },
      // Cosmos chains (synthetic IDs mapped to real chain IDs in API calls)
      { id: PERSISTENCE_CHAIN_ID, name: "Persistence", key: "persistence", providers: ["squid"] },
      { id: COSMOSHUB_CHAIN_ID, name: "Cosmos Hub", key: "cosmoshub", providers: ["squid"] },
    ];
  }
}
