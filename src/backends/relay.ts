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
import { buildApproveData, NATIVE_ADDRESS } from "../utils/evm.js";
import { estimateGasCostUsd, getGasUnits } from "../utils/gas-estimator.js";

const BASE_URL = "https://api.relay.link";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Relay ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// buildApproveData imported from ../utils/evm.js

export class RelayBackend implements BridgeBackend {
  name = "relay";
  private appFeeRecipient?: string;
  private appFeeBps?: string;

  constructor(appFeeRecipient?: string, appFeeBps?: string) {
    this.appFeeRecipient = appFeeRecipient;
    this.appFeeBps = appFeeBps;
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const body: any = {
        user: params.fromAddress,
        originChainId: params.fromChainId,
        destinationChainId: params.toChainId,
        originCurrency: params.fromTokenAddress === NATIVE_ADDRESS
          ? NATIVE_ADDRESS
          : params.fromTokenAddress,
        destinationCurrency: params.toTokenAddress === NATIVE_ADDRESS
          ? NATIVE_ADDRESS
          : params.toTokenAddress,
        amount: params.amountRaw,
        tradeType: "EXACT_INPUT",
      };

      if (params.toAddress) {
        body.recipient = params.toAddress;
      }
      if (this.appFeeRecipient && this.appFeeBps) {
        body.appFees = [{ recipient: this.appFeeRecipient, fee: this.appFeeBps }];
      }

      const data = await fetchJson(`${BASE_URL}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!data.steps || data.steps.length === 0) return null;

      // Extract output details from the quote
      const details = data.details ?? {};
      const outputRaw = details.currencyOut?.amount ?? "0";
      const outputDecimals = details.currencyOut?.currency?.decimals ?? 18;
      const srcSymbol = details.currencyIn?.currency?.symbol ?? "?";
      const dstSymbol = details.currencyOut?.currency?.symbol ?? "?";
      const feeUsd = Number(details.totalFee?.usd ?? 0);
      let gasFeeUsd = Number(details.gasFee?.usd ?? 0);
      const timeEstimate = details.timeEstimate ?? 60;

      // Relay includes relayer gas in their fee, so API often reports 0 for gas.
      // But the user still pays source chain gas to submit the tx — estimate it.
      let usingFallbackPrices: boolean | undefined;
      if (gasFeeUsd < 0.001) {
        const gasUnits = getGasUnits("relay", params.fromChainId);
        const gasEstimate = await estimateGasCostUsd(params.fromChainId, gasUnits);
        if (gasEstimate !== null) {
          gasFeeUsd = gasEstimate.costUsd;
          usingFallbackPrices = gasEstimate.usingFallbackPrices || undefined;
        }
      }

      // Relay is intent-based with deterministic pricing — min = estimated
      return {
        backendName: "relay",
        provider: "Relay (direct)",
        outputAmount: formatTokenAmount(outputRaw, outputDecimals),
        outputAmountRaw: outputRaw,
        minOutputAmount: formatTokenAmount(outputRaw, outputDecimals),
        minOutputAmountRaw: outputRaw,
        outputDecimals,
        estimatedGasCostUsd: Math.round(gasFeeUsd * 100) / 100,
        usingFallbackPrices,
        estimatedFeeUsd: feeUsd + gasFeeUsd,
        feeBreakdown: { gasCostUsd: gasFeeUsd, protocolFeeUsd: feeUsd, integratorFeeUsd: 0, integratorFeePercent: null, totalFeeUsd: feeUsd + gasFeeUsd },
        estimatedTimeSeconds: timeEstimate,
        route: `${srcSymbol} → Relay → ${dstSymbol}`,
        quoteData: data,
        // Relay quotes include step-level expiry. Use it if available, else 30s default.
        expiresAt: data.steps?.[0]?.items?.[0]?.data?.expiresAt
          ? new Date(data.steps[0].items[0].data.expiresAt).getTime()
          : Date.now() + 30_000,
      };
    } catch (err) {
      console.error("[relay] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const data = quote.quoteData as any;

    // Relay returns steps, each step has items, each item has a transaction
    const steps = data.steps ?? [];
    if (steps.length === 0) throw new Error("No steps in Relay quote");

    // Find the main transaction step (usually the first or only step)
    let mainTx: any = null;
    let approvalTx: any = null;

    for (const step of steps) {
      for (const item of step.items ?? []) {
        if (item.data?.data) {
          if (step.id === "approve" || item.id === "approve") {
            approvalTx = item.data;
          } else {
            mainTx = item.data;
          }
        }
      }
    }

    if (!mainTx || !mainTx.to || !mainTx.data) {
      throw new Error("No valid transaction data in Relay quote steps");
    }

    const result: TransactionRequest = {
      to: mainTx.to,
      data: mainTx.data,
      value: mainTx.value ? `0x${BigInt(mainTx.value).toString(16)}` : "0x0",
      chainId: mainTx.chainId ?? data.details?.currencyIn?.currency?.chainId ?? 0,
      provider: "relay",
      trackingId: `relay:${data.requestId ?? Date.now()}`,
    };

    if (approvalTx) {
      result.approvalTx = {
        to: approvalTx.to,
        data: approvalTx.data,
        value: "0x0",
        chainId: approvalTx.chainId ?? result.chainId,
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

      // Extract requestId from trackingId ("relay:<requestId>")
      const requestId = trackingId.startsWith("relay:")
        ? trackingId.slice("relay:".length)
        : undefined;

      if (!requestId && !txHash) {
        return {
          state: "unknown",
          humanReadable: "No requestId or txHash for Relay status check",
          provider: "relay",
          elapsed: 0,
        };
      }

      // Prefer requestId (reliable), fall back to txHash query
      // Use v3 endpoint (v2 is deprecated)
      const queryParam = requestId
        ? `requestId=${requestId}`
        : `txHash=${txHash}`;

      const data = await fetchJson(
        `${BASE_URL}/intents/status/v3?${queryParam}`
      );

      // Relay v3 status values (from docs):
      //   waiting   — Waiting for deposit confirmation
      //   pending   — Deposit confirmed, pending destination chain submission
      //   submitted — Destination transaction submitted
      //   success   — Successful fill on destination
      //   delayed   — Destination fill delayed, still processing
      //   refunded  — Successfully refunded
      //   refund    — Refund alias
      //   failure   — Unsuccessful fill
      const stateMap: Record<string, BridgeStatus["state"]> = {
        waiting: "pending",
        pending: "in_progress",
        submitted: "in_progress",
        delayed: "in_progress",
        success: "completed",
        failure: "failed",
        refund: "refunded",
        refunded: "refunded",
      };

      const mappedState = stateMap[data.status];
      if (!mappedState && data.status && data.status !== "unknown") {
        console.warn(`[relay] unmapped status: "${data.status}" — treating as pending`);
      }

      const destChainId = data.destinationChainId;
      const sourceChainId = data.originChainId;

      return {
        state: mappedState ?? (data.status === "unknown" ? "unknown" : "pending"),
        humanReadable: `Relay bridge: ${data.status ?? "unknown"}`,
        sourceTxHash: txHash ?? data.inTxHashes?.[0],
        destTxHash: data.txHashes?.[0],
        provider: "relay",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "relay",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/chains`);
      if (Array.isArray(data.chains)) {
        return data.chains.map((c: any) => ({
          id: c.id,
          name: c.name ?? `Chain ${c.id}`,
          key: (c.name ?? `chain-${c.id}`).toLowerCase().replace(/\s+/g, "-"),
          logoURI: c.icon,
          providers: ["relay"],
        }));
      }
    } catch {
      // Fallback
    }
    return getAllChains().map((c) => ({
      ...c,
      providers: ["relay"],
    }));
  }
}
