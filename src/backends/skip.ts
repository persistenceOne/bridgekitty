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
import { lookupByAddress } from "../utils/token-registry.js";

const BASE_URL = "https://api.skip.build";
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Skip ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class SkipBackend implements BridgeBackend {
  name = "skip";
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["authorization"] = this.apiKey;
    return h;
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      const body = {
        source_asset_denom: params.fromTokenAddress,
        source_asset_chain_id: String(params.fromChainId),
        dest_asset_denom: params.toTokenAddress,
        dest_asset_chain_id: String(params.toChainId),
        amount_in: params.amountRaw,
        smart_relay: true,
        allow_multi_tx: false,
        allow_unsafe: false,
      };

      const data = await fetchJson(`${BASE_URL}/v2/fungible/route`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!data.amount_out) return null;

      const outputRaw = data.amount_out;
      // Skip API doesn't return token decimals — resolve from registry or params
      const toTokenInfo = lookupByAddress(params.toTokenAddress, params.toChainId);
      const decimals = params.toTokenDecimals ?? toTokenInfo?.decimals ?? 18;
      const estimatedTime = data.estimated_route_duration_seconds ?? 300;

      // Parse fees from response
      let totalFeeUsd = 0;
      if (data.estimated_fees && Array.isArray(data.estimated_fees)) {
        for (const fee of data.estimated_fees) {
          if (fee.usd_amount) totalFeeUsd += parseFloat(fee.usd_amount);
        }
      }

      // Build route description from operations
      const ops = data.operations ?? [];
      const routeParts: string[] = [];
      for (const op of ops) {
        if (op.swap) routeParts.push(`swap via ${op.swap.swap_venue?.name ?? "DEX"}`);
        else if (op.transfer) routeParts.push(`bridge via ${op.transfer.bridge_id ?? "IBC"}`);
        else if (op.axelar_transfer) routeParts.push("bridge via Axelar");
        else if (op.cctp_transfer) routeParts.push("bridge via CCTP");
        else if (op.hyperlane_transfer) routeParts.push("bridge via Hyperlane");
        else if (op.go_fast_transfer) routeParts.push("bridge via Go Fast");
        else if (op.stargate_transfer) routeParts.push("bridge via Stargate");
      }
      const route = routeParts.length > 0
        ? `Skip (${routeParts.join(" → ")})`
        : "Skip Router";

      const feeBreakdown: FeeBreakdown = {
        gasCostUsd: null,
        protocolFeeUsd: Math.round(totalFeeUsd * 100) / 100,
        integratorFeeUsd: 0,
        integratorFeePercent: null,
        totalFeeUsd: totalFeeUsd > 0 ? Math.round(totalFeeUsd * 100) / 100 : null,
      };

      // Check for warnings
      const warning = data.warning;

      // Skip doesn't provide a separate minOutput — apply 0.5% slippage buffer
      let minOutputRaw: string;
      try {
        const outputBig = BigInt(outputRaw);
        minOutputRaw = (outputBig * 995n / 1000n).toString();
      } catch {
        minOutputRaw = outputRaw;
      }

      return {
        backendName: "skip",
        provider: `Skip Router${warning ? ` (${warning.type ?? "warning"})` : ""}`,
        outputAmount: formatTokenAmount(outputRaw, decimals),
        outputAmountRaw: outputRaw,
        minOutputAmount: formatTokenAmount(minOutputRaw, decimals),
        minOutputAmountRaw: minOutputRaw,
        outputDecimals: decimals,
        estimatedGasCostUsd: null,
        estimatedFeeUsd: totalFeeUsd > 0 ? Math.round(totalFeeUsd * 100) / 100 : null,
        feeBreakdown,
        estimatedTimeSeconds: estimatedTime,
        route,
        quoteData: {
          routeResponse: data,
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
      console.error("[skip] quote error:", (err as Error).message);
      return null;
    }
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const qd = quote.quoteData as any;
    const routeResp = qd.routeResponse;
    const p = qd.params;

    // Build the address list — one address per chain in the route
    const chainIds: string[] = routeResp.chain_ids ?? [String(p.fromChainId), String(p.toChainId)];
    const addressList = chainIds.map(() => p.fromAddress);
    // Set destination address for the last chain
    if (p.toAddress && addressList.length > 0) {
      addressList[addressList.length - 1] = p.toAddress;
    }

    const body = {
      source_asset_denom: routeResp.source_asset_denom ?? p.fromTokenAddress,
      source_asset_chain_id: routeResp.source_asset_chain_id ?? String(p.fromChainId),
      dest_asset_denom: routeResp.dest_asset_denom ?? p.toTokenAddress,
      dest_asset_chain_id: routeResp.dest_asset_chain_id ?? String(p.toChainId),
      amount_in: routeResp.amount_in ?? p.amountRaw,
      amount_out: routeResp.amount_out,
      address_list: addressList,
      operations: routeResp.operations,
      slippage_tolerance_percent: "1.0",
    };

    const data = await fetchJson(`${BASE_URL}/v2/fungible/msgs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    // Extract the first EVM transaction
    const txs = data.txs ?? data.msgs ?? [];
    if (txs.length === 0) throw new Error("No transaction messages from Skip");

    // Find an EVM tx in the response
    let evmTx: any = null;
    for (const tx of txs) {
      if (tx.evm_tx) {
        evmTx = tx.evm_tx;
        break;
      }
    }

    if (!evmTx) {
      // If no EVM tx, this might be a Cosmos-only route — not supported for unsigned tx return
      throw new Error("Skip route requires non-EVM signing (Cosmos/Solana) which is not supported in this mode. Use EVM chains.");
    }

    const chainId = Number(evmTx.chain_id ?? p.fromChainId);

    // Handle ERC20 approvals
    let approvalTx: TransactionRequest["approvalTx"] | undefined;
    const approvals = evmTx.required_erc20_approvals ?? [];
    if (approvals.length > 0) {
      const approval = approvals[0]; // Take first required approval
      approvalTx = {
        to: approval.token_contract ?? approval.token_address,
        data: buildApproveData(approval.spender, approval.amount),
        value: "0x0",
        chainId,
      };
    }

    // Ensure data has 0x prefix (Skip API sometimes omits it)
    const txData = evmTx.data?.startsWith("0x") ? evmTx.data : `0x${evmTx.data}`;

    return {
      to: evmTx.to,
      data: txData,
      value: evmTx.value ? `0x${BigInt(evmTx.value).toString(16)}` : "0x0",
      chainId,
      provider: "skip",
      trackingId: `skip:${evmTx.chain_id ?? p.fromChainId}:${Date.now()}`,
      approvalTx,
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
          humanReadable: "No transaction hash provided for Skip status check",
          provider: "skip",
          elapsed: 0,
        };
      }

      // Extract chain_id from trackingId ("skip:<chainId>:<timestamp>")
      const parts = trackingId.split(":");
      const chainId = parts.length >= 2 ? parts[1] : (meta?.fromChain ?? "1");

      const url = `${BASE_URL}/v2/tx/status?tx_hash=${txHash}&chain_id=${chainId}`;
      const data = await fetchJson(url, { headers: this.headers() });

      const stateMap: Record<string, BridgeStatus["state"]> = {
        STATE_SUBMITTED: "pending",
        STATE_PENDING: "in_progress",
        STATE_COMPLETED_SUCCESS: "completed",
        STATE_COMPLETED_ERROR: "failed",
        STATE_ABANDONED: "failed",
        STATE_PENDING_ERROR: "in_progress",
      };

      const skipState = data.state ?? "unknown";

      // Try to extract destination tx hash from transfer sequence
      let destTxHash: string | undefined;
      const transfers = data.transfers ?? data.transfer_sequence ?? [];
      for (const t of transfers) {
        if (t.receive_tx?.hash) destTxHash = t.receive_tx.hash;
        if (t.packet_txs?.receive_tx?.tx_hash) destTxHash = t.packet_txs.receive_tx.tx_hash;
      }

      return {
        state: stateMap[skipState] ?? "in_progress",
        humanReadable: `Skip bridge: ${skipState.replace("STATE_", "").toLowerCase()}${data.error?.message ? ` (${data.error.message})` : ""}`,
        sourceTxHash: txHash,
        destTxHash,
        provider: "skip",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${(err as Error).message}`,
        provider: "skip",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    try {
      const data = await fetchJson(`${BASE_URL}/v2/info/chains`, {
        headers: this.headers(),
      });

      const chains: any[] = data.chains ?? [];
      return chains
        .filter((c: any) => !c.is_testnet)
        .map((c: any) => ({
          id: isNaN(Number(c.chain_id)) ? 0 : Number(c.chain_id), // Cosmos chains have string IDs
          name: c.pretty_name ?? c.chain_name ?? `Chain ${c.chain_id}`,
          key: (c.chain_name ?? `chain-${c.chain_id}`).toLowerCase().replace(/\s+/g, "-"),
          logoURI: c.logo_uri,
          providers: ["skip"],
        }));
    } catch (err) {
      console.error("[skip] getSupportedChains error:", (err as Error).message);
      return [
        { id: 1, name: "Ethereum", key: "ethereum", providers: ["skip"] },
        { id: 56, name: "BNB Chain", key: "bsc", providers: ["skip"] },
        { id: 137, name: "Polygon", key: "polygon", providers: ["skip"] },
        { id: 42161, name: "Arbitrum", key: "arbitrum", providers: ["skip"] },
        { id: 10, name: "Optimism", key: "optimism", providers: ["skip"] },
        { id: 43114, name: "Avalanche", key: "avalanche", providers: ["skip"] },
        { id: 8453, name: "Base", key: "base", providers: ["skip"] },
      ];
    }
  }

  async getSupportedTokens(chainId: number): Promise<TokenInfo[]> {
    try {
      // Skip uses /v2/fungible/assets endpoint
      const data = await fetchJson(
        `${BASE_URL}/v2/fungible/assets?chain_id=${chainId}&include_evm_assets=true`,
        { headers: this.headers() }
      );

      const chainAssets = data.chain_to_assets_map?.[String(chainId)]?.assets ?? [];
      return chainAssets.slice(0, 50).map((t: any) => ({
        symbol: t.symbol ?? t.recommended_symbol ?? "?",
        name: t.name ?? t.symbol ?? "Unknown",
        address: t.denom,
        decimals: t.decimals ?? 18,
        chainId,
        logoURI: t.logo_uri,
      }));
    } catch (err) {
      console.error("[skip] getSupportedTokens error:", (err as Error).message);
      return [];
    }
  }
}
