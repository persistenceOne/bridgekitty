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

const BASE_URL = "https://api.dln.trade/v1.0";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`deBridge ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildApproveData(spender: string, amount: string): string {
  const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0x095ea7b3${spenderPadded}${amountHex}`;
}

export class DeBridgeBackend implements BridgeBackend {
  name = "debridge";

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const url = new URL(`${BASE_URL}/dln/order/quote`);
      url.searchParams.set("srcChainId", String(params.fromChainId));
      url.searchParams.set("srcChainTokenIn", params.fromTokenAddress);
      url.searchParams.set("srcChainTokenInAmount", params.amountRaw);
      url.searchParams.set("dstChainId", String(params.toChainId));
      url.searchParams.set("dstChainTokenOut", params.toTokenAddress);
      url.searchParams.set("prependOperatingExpenses", "true");

      const data = await fetchJson(url.toString());

      if (!data.estimation) return null;

      const dstAmount = data.estimation.dstChainTokenOut?.amount ?? "0";
      const dstDecimals = data.estimation.dstChainTokenOut?.decimals ?? 18;
      const srcTokenSymbol = data.estimation.srcChainTokenIn?.symbol ?? "?";
      const dstTokenSymbol = data.estimation.dstChainTokenOut?.symbol ?? "?";

      // Calculate fee from operating expenses
      const operatingExpenseUsd = Number(data.estimation.costsDetails?.find(
        (c: any) => c.type === "DlnProtocolFee"
      )?.payload?.feeAmount ?? 0) / 1e6; // typically in USDC units
      const totalFeeUsd = Number(data.estimation.costsDetails?.reduce(
        (sum: number, c: any) => sum + Number(c.payload?.feeAmountInUsd ?? 0),
        0
      ) ?? 0);

      return {
        provider: "debridge",
        outputAmount: formatTokenAmount(dstAmount, dstDecimals),
        outputAmountRaw: dstAmount,
        estimatedFeeUsd: totalFeeUsd || operatingExpenseUsd,
        estimatedTimeSeconds: data.estimation.estimatedFulfillmentDelay ?? 30,
        route: `${srcTokenSymbol} → deBridge DLN → ${dstTokenSymbol}`,
        quoteData: {
          estimation: data.estimation,
          order: data.order,
          params: {
            srcChainId: params.fromChainId,
            dstChainId: params.toChainId,
            srcChainTokenIn: params.fromTokenAddress,
            dstChainTokenOut: params.toTokenAddress,
            srcChainTokenInAmount: params.amountRaw,
            fromAddress: params.fromAddress,
            toAddress: params.toAddress || params.fromAddress,
          },
        },
        expiresAt: Date.now() + 60_000,
      };
    } catch (err) {
      console.error("[debridge] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const p = qd.params;

    // Use create-tx endpoint to get the actual transaction
    const url = new URL(`${BASE_URL}/dln/order/create-tx`);
    url.searchParams.set("srcChainId", String(p.srcChainId));
    url.searchParams.set("srcChainTokenIn", p.srcChainTokenIn);
    url.searchParams.set("srcChainTokenInAmount", p.srcChainTokenInAmount);
    url.searchParams.set("dstChainId", String(p.dstChainId));
    url.searchParams.set("dstChainTokenOut", p.dstChainTokenOut);
    url.searchParams.set("dstChainTokenOutAmount", "auto");
    url.searchParams.set("srcChainOrderAuthorityAddress", p.fromAddress);
    url.searchParams.set("dstChainTokenOutRecipient", p.toAddress);
    url.searchParams.set("prependOperatingExpenses", "true");

    const data = await fetchJson(url.toString());

    if (!data.tx) throw new Error("No transaction in deBridge create-tx response");

    const orderId = data.orderId ?? `debridge:${Date.now()}`;

    const result: TransactionRequest = {
      to: data.tx.to,
      data: data.tx.data,
      value: data.tx.value ? `0x${BigInt(data.tx.value).toString(16)}` : "0x0",
      chainId: p.srcChainId,
      provider: "debridge",
      trackingId: `debridge:${orderId}`,
    };

    // Check if ERC20 approval is needed (non-native token)
    if (data.tx.allowanceTarget && p.srcChainTokenIn !== "0x0000000000000000000000000000000000000000") {
      result.approvalTx = {
        to: p.srcChainTokenIn,
        data: buildApproveData(data.tx.allowanceTarget, p.srcChainTokenInAmount),
        value: "0x0",
        chainId: p.srcChainId,
      };
    }

    return result;
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>
  ): Promise<BridgeStatus> {
    try {
      const orderId = trackingId.replace("debridge:", "");
      const url = new URL(`${BASE_URL}/dln/order/${orderId}/status`);

      const data = await fetchJson(url.toString());

      const stateMap: Record<string, BridgeStatus["state"]> = {
        None: "pending",
        Created: "pending",
        Fulfilled: "completed",
        SentUnlock: "completed",
        OrderCancelled: "failed",
        SentOrderCancel: "failed",
        ClaimedUnlock: "completed",
        ClaimedOrderCancel: "refunded",
      };

      return {
        state: stateMap[data.status] ?? "in_progress",
        humanReadable: `deBridge DLN order: ${data.status ?? "unknown"}`,
        sourceTxHash: meta?.txHash,
        destTxHash: data.fulfillTxHash,
        provider: "debridge",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "debridge",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    // deBridge supports major EVM chains — return our known chains
    // with debridge as a provider
    try {
      const data = await fetchJson(`${BASE_URL}/supported-chains-info`);
      if (data.chains) {
        return Object.entries(data.chains).map(([id, info]: [string, any]) => ({
          id: Number(id),
          name: info.chainName ?? `Chain ${id}`,
          key: (info.chainName ?? `chain-${id}`).toLowerCase().replace(/\s+/g, "-"),
          providers: ["debridge"],
        }));
      }
    } catch {
      // Fallback to hardcoded chains if API fails
    }
    return getAllChains().map((c) => ({
      ...c,
      providers: ["debridge"],
    }));
  }
}
