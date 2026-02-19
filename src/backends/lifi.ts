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

const BASE_URL = "https://li.quest/v1";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LI.FI ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class LiFiBackend implements BridgeBackend {
  name = "lifi";
  private apiKey?: string;
  private integrator?: string;
  private integratorFee?: string;

  constructor(apiKey?: string, integrator?: string, integratorFee?: string) {
    this.apiKey = apiKey;
    this.integrator = integrator;
    this.integratorFee = integratorFee;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h["x-lifi-api-key"] = this.apiKey;
    return h;
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const url = new URL(`${BASE_URL}/quote`);
      url.searchParams.set("fromChain", String(params.fromChainId));
      url.searchParams.set("toChain", String(params.toChainId));
      url.searchParams.set("fromToken", params.fromTokenAddress);
      url.searchParams.set("toToken", params.toTokenAddress);
      url.searchParams.set("fromAmount", params.amountRaw);
      url.searchParams.set("fromAddress", params.fromAddress);
      if (params.toAddress) url.searchParams.set("toAddress", params.toAddress);
      url.searchParams.set(
        "order",
        params.preference === "fastest" ? "FASTEST" : "CHEAPEST"
      );
      url.searchParams.set("slippage", "0.005");
      if (this.integrator) {
        url.searchParams.set("integrator", this.integrator);
        if (this.integratorFee) url.searchParams.set("fee", this.integratorFee);
      }

      const data = await fetchJson(url.toString(), { headers: this.headers() });

      const gasCostUsd =
        data.estimate?.gasCosts?.reduce(
          (sum: number, g: any) => sum + Number(g.amountUSD || 0),
          0
        ) ?? 0;

      return {
        provider: "lifi",
        outputAmount: data.estimate?.toAmountMin
          ? formatTokenAmount(
              data.estimate.toAmountMin,
              data.action?.toToken?.decimals ?? 18
            )
          : "0",
        outputAmountRaw: data.estimate?.toAmountMin ?? "0",
        estimatedFeeUsd: gasCostUsd,
        estimatedTimeSeconds: data.estimate?.executionDuration ?? 300,
        route: `${data.action?.fromToken?.symbol ?? "?"} → ${data.toolDetails?.name ?? data.tool ?? "LI.FI"} → ${data.action?.toToken?.symbol ?? "?"}`,
        quoteData: data,
        expiresAt: Date.now() + 60_000,
      };
    } catch (err) {
      console.error("[lifi] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const data = quote.quoteData as any;
    const txReq = data.transactionRequest;
    if (!txReq) throw new Error("No transactionRequest in LI.FI quote");

    const result: TransactionRequest = {
      to: txReq.to,
      data: txReq.data,
      value: txReq.value ?? "0x0",
      chainId: txReq.chainId,
      gasLimit: txReq.gasLimit,
      provider: "lifi",
      trackingId: `lifi:${data.tool ?? "unknown"}:${Date.now()}`,
    };

    // Check if approval is needed
    if (data.estimate?.approvalAddress && data.action?.fromToken?.address) {
      const tokenAddr = data.action.fromToken.address;
      // Non-native tokens may need approval
      if (tokenAddr !== "0x0000000000000000000000000000000000000000") {
        // LI.FI quote includes approval info but not the tx — agent handles ERC20 approve
        result.approvalTx = {
          to: tokenAddr,
          data: buildApproveData(data.estimate.approvalAddress, data.action.fromAmount),
          value: "0x0",
          chainId: txReq.chainId,
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
      const fromChain = meta?.fromChain;
      const toChain = meta?.toChain;
      if (!txHash) {
        return {
          state: "unknown",
          humanReadable: "No transaction hash provided for status check",
          provider: "lifi",
          elapsed: 0,
        };
      }

      const url = new URL(`${BASE_URL}/status`);
      url.searchParams.set("txHash", txHash);
      if (fromChain) url.searchParams.set("fromChain", fromChain);
      if (toChain) url.searchParams.set("toChain", toChain);

      const data = await fetchJson(url.toString(), { headers: this.headers() });

      const stateMap: Record<string, BridgeStatus["state"]> = {
        NOT_FOUND: "pending",
        PENDING: "pending",
        DONE: "completed",
        FAILED: "failed",
      };

      const elapsed = data.sending?.timestamp
        ? Math.floor((Date.now() - data.sending.timestamp * 1000) / 1000)
        : 0;

      return {
        state: stateMap[data.status] ?? "in_progress",
        humanReadable: `Bridge via ${data.tool ?? "LI.FI"}: ${data.status ?? "unknown"}${data.substatus ? ` (${data.substatus})` : ""}`,
        sourceTxHash: data.sending?.txHash,
        destTxHash: data.receiving?.txHash,
        provider: "lifi",
        elapsed,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "lifi",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    const data = await fetchJson(`${BASE_URL}/chains`, {
      headers: this.headers(),
    });
    return (data.chains ?? []).map((c: any) => ({
      id: c.id,
      name: c.name,
      key: c.key,
      logoURI: c.logoURI,
      providers: ["lifi"],
    }));
  }

  async getSupportedTokens(chainId: number): Promise<TokenInfo[]> {
    const data = await fetchJson(
      `${BASE_URL}/tokens?chains=${chainId}`,
      { headers: this.headers() }
    );
    const tokens = data.tokens?.[String(chainId)] ?? [];
    return tokens.slice(0, 50).map((t: any) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      chainId: t.chainId,
      logoURI: t.logoURI,
    }));
  }
}

function buildApproveData(spender: string, amount: string): string {
  // ERC20 approve(address,uint256) selector = 0x095ea7b3
  const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0x095ea7b3${spenderPadded}${amountHex}`;
}
