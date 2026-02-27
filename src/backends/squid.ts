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

const BASE_URL = "https://v2.api.squidrouter.com/v2";
const TIMEOUT_MS = 15_000;

// BridgeKitty integrator ID — use "squid-swap-widget" (public/testing) until
// we register a proper integrator ID at squidrouter.typeform.com
const BRIDGEKITTY_SQUID_INTEGRATOR = "squid-swap-widget";

function getIntegratorId(): string {
  return BRIDGEKITTY_SQUID_INTEGRATOR;
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

function headers(): Record<string, string> {
  return {
    "x-integrator-id": getIntegratorId(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export class SquidBackend implements BridgeBackend {
  name = "squid";

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const body = {
        fromAddress: params.fromAddress,
        fromChain: String(params.fromChainId),
        fromToken: params.fromTokenAddress,
        fromAmount: params.amountRaw,
        toChain: String(params.toChainId),
        toToken: params.toTokenAddress,
        toAddress: params.toAddress || params.fromAddress,
        slippage: 0.5, // 0.5%
        quoteOnly: true,
      };

      const data = await fetchJson(`${BASE_URL}/route`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });

      const route = data.route;
      if (!route?.estimate) return null;

      const estimate = route.estimate;
      const outputRaw = estimate.toAmount ?? "0";
      const minOutputRaw = estimate.toAmountMin ?? outputRaw;
      const decimals = estimate.toToken?.decimals ?? params.toTokenDecimals ?? 18;

      // Fee breakdown
      const gasCostUsd = estimate.gasCosts
        ? estimate.gasCosts.reduce((sum: number, g: any) => sum + parseFloat(g.amountUSD || "0"), 0)
        : 0;
      const protocolFeeUsd = estimate.feeCosts
        ? estimate.feeCosts.reduce((sum: number, f: any) => sum + parseFloat(f.amountUSD || "0"), 0)
        : 0;
      const totalFeeUsd = gasCostUsd + protocolFeeUsd;

      const feeBreakdown: FeeBreakdown = {
        gasCostUsd: Math.round(gasCostUsd * 100) / 100,
        protocolFeeUsd: Math.round(protocolFeeUsd * 100) / 100,
        integratorFeeUsd: 0,
        integratorFeePercent: null,
        totalFeeUsd: Math.round(totalFeeUsd * 100) / 100,
      };

      const estimatedTime = estimate.estimatedRouteDuration ?? 300;

      // Build route description
      const fromSymbol = estimate.fromToken?.symbol ?? "?";
      const toSymbol = estimate.toToken?.symbol ?? "?";

      return {
        backendName: "squid",
        provider: "Squid Router",
        outputAmount: formatTokenAmount(outputRaw, decimals),
        outputAmountRaw: outputRaw,
        minOutputAmount: formatTokenAmount(minOutputRaw, decimals),
        minOutputAmountRaw: minOutputRaw,
        outputDecimals: decimals,
        estimatedGasCostUsd: Math.round(gasCostUsd * 100) / 100,
        estimatedFeeUsd: Math.round(totalFeeUsd * 100) / 100,
        feeBreakdown,
        estimatedTimeSeconds: estimatedTime,
        route: `${fromSymbol} → Squid Router → ${toSymbol}`,
        quoteData: {
          route,
          params: {
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            fromTokenAddress: params.fromTokenAddress,
            toTokenAddress: params.toTokenAddress,
            amountRaw: params.amountRaw,
            fromAddress: params.fromAddress,
            toAddress: params.toAddress || params.fromAddress,
          },
        },
        expiresAt: Date.now() + 30_000,
      };
    } catch (err) {
      console.error("[squid] quote error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Build the approval transaction (if needed) without fetching the bridge tx.
   * This avoids Squid's nonce-race: the bridge tx nonce would be stale after approval.
   * Call `buildBridgeTransaction` AFTER the approval is confirmed on-chain.
   */
  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const p = qd.params;

    // First, check if approval is needed by fetching the route
    const body = this._routeBody(p, false);
    const data = await fetchJson(`${BASE_URL}/route`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    const route = data.route;
    const txReq = route?.transactionRequest;
    if (!txReq) throw new Error("No transactionRequest in Squid route response");

    const chainId = Number(txReq.chainId ?? p.fromChainId);
    const approvalTarget = txReq.approvalAddress ?? txReq.target ?? txReq.to;
    const needsApproval = approvalTarget && !isNativeToken(p.fromTokenAddress);

    if (needsApproval) {
      // Return ONLY the approval tx — the bridge tx will be fetched fresh
      // after approval confirms (via the calling code's second buildTransaction call,
      // or via the needsPostApprovalBuild flag).
      return {
        to: txReq.target ?? txReq.to,
        data: txReq.data,
        value: txReq.value ?? "0x0",
        chainId,
        provider: "squid",
        trackingId: `squid:${route.quoteId ?? Date.now()}`,
        approvalTx: {
          to: p.fromTokenAddress,
          data: buildApproveData(approvalTarget, p.amountRaw),
          value: "0x0",
          chainId,
        },
        // Flag: callers should re-fetch route after approval to get fresh nonce
        needsPostApprovalBuild: true,
      };
    }

    // No approval needed — return bridge tx directly
    return {
      to: txReq.target ?? txReq.to,
      data: txReq.data,
      value: txReq.value ?? "0x0",
      chainId,
      provider: "squid",
      trackingId: `squid:${route.quoteId ?? Date.now()}`,
    };
  }

  private _routeBody(p: any, quoteOnly: boolean) {
    return {
      fromAddress: p.fromAddress,
      fromChain: String(p.fromChainId),
      fromToken: p.fromTokenAddress,
      fromAmount: p.amountRaw,
      toChain: String(p.toChainId),
      toToken: p.toTokenAddress,
      toAddress: p.toAddress || p.fromAddress,
      slippage: 0.5,
      quoteOnly,
    };
  }

  /**
   * Re-fetch the bridge transaction AFTER approval is confirmed.
   * This ensures Squid returns a tx with the correct (post-approval) nonce.
   */
  async buildBridgeTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const p = qd.params;

    // Small delay to avoid Squid rate limiting (429) after the first buildTransaction call
    await new Promise((r) => setTimeout(r, 1500));

    const body = this._routeBody(p, false);
    const data = await fetchJson(`${BASE_URL}/route`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    const route = data.route;
    const txReq = route?.transactionRequest;
    if (!txReq) throw new Error("No transactionRequest in Squid route response (post-approval)");

    return {
      to: txReq.target ?? txReq.to,
      data: txReq.data,
      value: txReq.value ?? "0x0",
      chainId: Number(txReq.chainId ?? p.fromChainId),
      provider: "squid",
      trackingId: `squid:${route.quoteId ?? Date.now()}`,
    };
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>,
  ): Promise<BridgeStatus> {
    try {
      const txHash = meta?.txHash;
      if (!txHash) {
        return {
          state: "unknown",
          humanReadable: "No transaction hash provided for Squid status check",
          provider: "squid",
          elapsed: 0,
        };
      }

      const fromChain = meta?.fromChain ?? "1";
      const toChain = meta?.toChain ?? "1";

      const url = new URL(`${BASE_URL}/status`);
      url.searchParams.set("transactionId", txHash);
      url.searchParams.set("fromChainId", fromChain);
      url.searchParams.set("toChainId", toChain);
      if (meta?.requestId) {
        url.searchParams.set("requestId", meta.requestId);
      }

      const data = await fetchJson(url.toString(), { headers: headers() });

      const stateMap: Record<string, BridgeStatus["state"]> = {
        ongoing: "in_progress",
        partial_success: "in_progress",
        success: "completed",
        needs_gas: "pending",
        not_found: "pending",
        failed: "failed",
      };

      const squidState = data.squidTransactionStatus ?? data.status ?? "unknown";

      return {
        state: stateMap[squidState] ?? "in_progress",
        humanReadable: `Squid bridge: ${squidState}${data.error ? ` (${data.error})` : ""}`,
        sourceTxHash: data.fromChain?.transactionId ?? txHash,
        destTxHash: data.toChain?.transactionId,
        provider: "squid",
        elapsed: data.fromChain?.timestamp
          ? Math.floor((Date.now() - data.fromChain.timestamp * 1000) / 1000)
          : 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "squid",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/chains`, { headers: headers() });
      const chains: any[] = data.chains ?? [];
      return chains.map((c: any) => ({
        id: Number(c.chainId),
        name: c.chainName ?? c.networkName ?? `Chain ${c.chainId}`,
        key: (c.chainName ?? c.networkName ?? `chain-${c.chainId}`).toLowerCase().replace(/\s+/g, "-"),
        logoURI: c.chainIconURI,
        providers: ["squid"],
      }));
    } catch (err) {
      console.error("[squid] getSupportedChains error:", (err as Error).message);
      // Fallback: major EVM chains
      return [
        { id: 1, name: "Ethereum", key: "ethereum", providers: ["squid"] },
        { id: 56, name: "BNB Chain", key: "bsc", providers: ["squid"] },
        { id: 137, name: "Polygon", key: "polygon", providers: ["squid"] },
        { id: 42161, name: "Arbitrum", key: "arbitrum", providers: ["squid"] },
        { id: 10, name: "Optimism", key: "optimism", providers: ["squid"] },
        { id: 43114, name: "Avalanche", key: "avalanche", providers: ["squid"] },
        { id: 8453, name: "Base", key: "base", providers: ["squid"] },
      ];
    }
  }

  async getSupportedTokens(chainId: number): Promise<TokenInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/tokens?chainId=${chainId}`, {
        headers: headers(),
      });
      const tokens: any[] = data.tokens ?? [];
      return tokens.slice(0, 50).map((t: any) => ({
        symbol: t.symbol,
        name: t.name ?? t.symbol,
        address: t.address,
        decimals: t.decimals,
        chainId: Number(t.chainId ?? chainId),
        logoURI: t.logoURI,
      }));
    } catch (err) {
      console.error("[squid] getSupportedTokens error:", (err as Error).message);
      return [];
    }
  }
}
