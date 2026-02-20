import type {
  BridgeBackend,
  BridgeQuote,
  BridgeStatus,
  ChainInfo,
  QuoteParams,
  TransactionRequest,
} from "./types.js";
import { formatTokenAmount } from "../utils/tokens.js";

const BASE_URL = "https://api.interop.persistence.one";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Persistence ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Persistence Interop currently supports BTC variants on Base and BSC
const SUPPORTED_CHAINS = [
  { id: 8453, name: "Base", key: "base" },
  { id: 56, name: "BNB Chain", key: "bsc" },
];

// Supported BTC token addresses
const BTC_TOKENS: Record<number, { address: string; symbol: string }> = {
  8453: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC" },
  56: { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB" },
};

export class PersistenceBackend implements BridgeBackend {
  name = "persistence";

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      // Only support BTC cross-chain between Base and BSC
      const fromBtc = BTC_TOKENS[params.fromChainId];
      const toBtc = BTC_TOKENS[params.toChainId];
      if (!fromBtc || !toBtc) return null;

      // Check if the from token matches our supported BTC variant (address or symbol)
      const fromAddr = params.fromTokenAddress.toLowerCase();
      if (
        fromAddr !== fromBtc.address.toLowerCase() &&
        fromAddr !== fromBtc.symbol.toLowerCase()
      ) {
        return null;
      }

      // Check if the to token matches our supported BTC variant
      const toAddr = params.toTokenAddress.toLowerCase();
      if (
        toAddr !== toBtc.address.toLowerCase() &&
        toAddr !== toBtc.symbol.toLowerCase()
      ) {
        return null;
      }

      const data = await fetchJson(`${BASE_URL}/quotes/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: params.fromChainId,
          destinationChainId: params.toChainId,
          sourceAsset: fromBtc.address,
          destinationAsset: toBtc.address,
          sourceAmount: params.amountRaw,
        }),
      });

      // API returns {quotes: [...]} or an array
      const quotes = Array.isArray(data) ? data : (data.quotes ?? [data]);
      if (!quotes.length || quotes[0]?.error) return null;

      const best = quotes.reduce((a: any, b: any) =>
        BigInt(b.estimatedDestinationAmount ?? "0") > BigInt(a.estimatedDestinationAmount ?? "0") ? b : a
      );

      const dstDecimals = toBtc.symbol === "BTCB" ? 18 : 8; // BTCB is 18 decimals on BSC
      const outputRaw = best.estimatedDestinationAmount ?? "0";
      const totalFeeBps = Number(best.totalFee ?? 0);
      // Fee is in basis units of the source token
      const feeUsd = 0; // Hard to convert to USD without price; leave 0 for now

      return {
        provider: "Persistence Interop (direct)",
        outputAmount: formatTokenAmount(outputRaw, dstDecimals),
        outputAmountRaw: outputRaw,
        estimatedFeeUsd: feeUsd,
        feeBreakdown: { gasCostUsd: 0, protocolFeeUsd: feeUsd, integratorFeeUsd: 0, integratorFeePercent: null, totalFeeUsd: feeUsd },
        estimatedTimeSeconds: 120,
        route: `${fromBtc.symbol} → Persistence Solver → ${toBtc.symbol}`,
        quoteData: best,
        expiresAt: best.expirationTime ? new Date(best.expirationTime).getTime() : Date.now() + 60_000,
      };
    } catch (err) {
      console.error("[persistence] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const data = quote.quoteData as any;

    // The Persistence Interop flow:
    // 1. Agent approves token spend to the escrow contract
    // 2. Agent calls the escrow contract to lock tokens
    // 3. Submit order to backend
    // The exact tx data should come from the quote response
    if (data.transactionRequest) {
      return {
        to: data.transactionRequest.to,
        data: data.transactionRequest.data,
        value: data.transactionRequest.value ?? "0x0",
        chainId: data.transactionRequest.chainId,
        gasLimit: data.transactionRequest.gasLimit,
        provider: "persistence",
        trackingId: `persistence:${data.orderId ?? Date.now()}`,
      };
    }

    throw new Error(
      "Persistence quote did not include transaction data. Manual order submission may be required via the Persistence Interop frontend."
    );
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>
  ): Promise<BridgeStatus> {
    try {
      const orderId = meta?.orderId ?? trackingId.replace("persistence:", "");
      const data = await fetchJson(
        `${BASE_URL}/orders/reclaim-status/${orderId}`
      );

      const stateMap: Record<string, BridgeStatus["state"]> = {
        pending: "pending",
        filled: "completed",
        completed: "completed",
        failed: "failed",
        refunded: "refunded",
      };

      return {
        state: stateMap[data.status] ?? "in_progress",
        humanReadable: `Persistence Interop: ${data.status ?? "unknown"}`,
        sourceTxHash: data.sourceTxHash,
        destTxHash: data.destinationTxHash,
        provider: "persistence",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "persistence",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    return SUPPORTED_CHAINS.map((c) => ({
      ...c,
      providers: ["persistence"],
    }));
  }
}
