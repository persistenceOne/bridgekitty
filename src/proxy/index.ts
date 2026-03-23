/**
 * ProxyRoutingEngine — drop-in replacement for RoutingEngine when
 * BRIDGEKITTY_BACKEND_URL is set. Proxies all calls to the hosted backend.
 *
 * Usage in src/index.ts:
 *   const engine = backendUrl
 *     ? createProxyEngine(backendUrl) as unknown as RoutingEngine
 *     : createEngine();
 */

import { ethers } from "ethers";
import type {
  BridgeBackend,
  BridgeQuote,
  BridgeStatus,
  ChainInfo,
  QuoteParams,
  TokenInfo,
  TransactionRequest,
} from "../backends/types.js";
import type { CachedQuote, FailedProvider } from "../routing/engine.js";
import { CircuitBreaker } from "../utils/circuit-breaker.js";
import { getProvider } from "../utils/gas-estimator.js";
import { BackendClient } from "./client.js";

// ─── Proxy backend ────────────────────────────────────────────────────────────

/**
 * A BridgeBackend that proxies buildTransaction and getStatus to the hosted backend.
 * Chains/tokens are also proxied.
 */
class ProxyBackend implements BridgeBackend {
  name: string;
  private client: BackendClient;

  constructor(name: string, client: BackendClient) {
    this.name = name;
    this.client = client;
  }

  async getQuote(_params: QuoteParams): Promise<BridgeQuote | null> {
    // Not called directly on proxy backends — getQuotes on the engine handles this.
    return null;
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    // Extract the server-side quoteId embedded in quoteData by ProxyRoutingEngine.getQuotes()
    const qd = quote.quoteData as Record<string, unknown> | null;
    const quoteId = qd?.__proxyQuoteId as string | undefined;
    if (!quoteId) {
      throw new Error("ProxyBackend: quote is missing __proxyQuoteId — was it returned by ProxyRoutingEngine?");
    }

    const res = (await this.client.execute({ quoteId })) as Record<string, unknown>;
    if (res.error) throw new Error(String(res.error));

    return {
      to: String(res.transaction ? (res.transaction as Record<string, unknown>).to : ""),
      data: String(res.transaction ? (res.transaction as Record<string, unknown>).data : ""),
      value: String(res.transaction ? (res.transaction as Record<string, unknown>).value : "0"),
      chainId: Number(res.transaction ? (res.transaction as Record<string, unknown>).chainId : 0),
      gasLimit: res.transaction
        ? String((res.transaction as Record<string, unknown>).gasLimit ?? "")
        : undefined,
      approvalTx: res.approvalTransaction as TransactionRequest["approvalTx"],
      needsPostApprovalBuild: Boolean(res.needsPostApprovalBuild),
      provider: String(res.provider ?? ""),
      trackingId: String(res.trackingId ?? ""),
      eip712: res.eip712 as TransactionRequest["eip712"],
      solanaTransaction: res.solanaTransaction as TransactionRequest["solanaTransaction"],
    };
  }

  /**
   * Persistence Interop sign-and-execute: signs the EIP-712 order client-side and
   * submits on-chain. Mirrors PersistenceBackend.signAndExecute() but works in proxy
   * mode by reconstructing the order from the EIP-712 data returned by buildTransaction().
   */
  async signAndExecute(
    quote: BridgeQuote,
    signer: ethers.Wallet,
  ): Promise<{ txHash: string; orderId: string; trackingId: string }> {
    const txRequest = await this.buildTransaction(quote);
    if (!txRequest.eip712) {
      throw new Error("ProxyBackend: no EIP-712 data returned for persistence sign-and-execute");
    }

    const { eip712 } = txRequest;
    const sourceChainId = txRequest.chainId;

    const provider = await getProvider(sourceChainId);
    const connectedSigner = signer.connect(provider);
    const swapperAddress = await connectedSigner.getAddress();

    const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const ERC20_ABI = [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ];
    const SETTLEMENT_ABI = [
      "function initiate(tuple(address settlementContract, address swapper, uint256 nonce, uint32 originChainId, uint32 initiateDeadline, uint32 fillDeadline, bytes orderData) order, bytes signature, bytes fillerData) external",
    ];

    // Step 1: Check and set Permit2 allowance
    const permitted = ((eip712.value as Record<string, unknown>).permitted) as Record<string, unknown>;
    const inputToken = String(permitted.token);
    const inputAmount = BigInt(String(permitted.amount));

    const erc20 = new ethers.Contract(inputToken, ERC20_ABI, connectedSigner);
    const currentAllowance: bigint = await erc20.allowance(swapperAddress, PERMIT2_ADDRESS);
    if (currentAllowance < inputAmount) {
      console.log("[proxy/persistence] Approving Permit2...");
      const approveTx = await erc20.approve(PERMIT2_ADDRESS, inputAmount);
      await approveTx.wait();
      // Wait for RPC propagation before calling initiate()
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // Step 2: Sign EIP-712 typed data
    const domain = eip712.domain as { name: string; chainId: number; verifyingContract: string };
    // ethers handles EIP712Domain via the domain param — remove if accidentally present
    const { EIP712Domain: _drop, ...signingTypes } = eip712.types as Record<string, unknown>;
    const value = eip712.value as Record<string, unknown>;

    let signature = await connectedSigner.signTypedData(
      domain,
      signingTypes as Record<string, Array<{ name: string; type: string }>>,
      value,
    );

    // Step 3: Build the order tuple from the witness (CrossChainOrder) in the EIP-712 value
    const buildOrderTuple = (w: Record<string, unknown>) => [
      String(w.settlementContract),
      String(w.swapper),
      BigInt(String(w.nonce)),
      Number(w.originChainId),
      Number(w.initiateDeadline),
      Number(w.fillDeadline),
      String(w.orderData),
    ];

    const settlement = new ethers.Contract(txRequest.to, SETTLEMENT_ABI, connectedSigner);
    const fillerData = ethers.zeroPadValue("0x", 32);
    let witness = (value.witness as Record<string, unknown>);
    let orderTuple = buildOrderTuple(witness);

    let initiateTx!: ethers.ContractTransactionResponse;
    let lastError: unknown = null;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        initiateTx = await settlement.initiate(orderTuple, signature, fillerData);
        const receipt = await initiateTx.wait();
        if (receipt && receipt.status === 0) {
          throw new Error("Initiate transaction reverted on-chain");
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const msg = (err as Error).message ?? "";

        const isTransferError =
          msg.includes("TRANSFER_FROM_FAILED") ||
          msg.includes("TRANSFER_FAILED") ||
          msg.includes("insufficient balance");
        const isNonceError = !isTransferError && (
          msg.includes("NONCE_ALREADY_USED") ||
          msg.includes("InvalidNonce") ||
          msg.includes("nonce too low") ||
          msg.includes("nonce has already been used")
        );

        if ((isNonceError || isTransferError) && attempt < MAX_RETRIES) {
          if (isTransferError) {
            console.warn("[proxy/persistence] Transfer error — waiting 3s for approval propagation...");
            await new Promise((r) => setTimeout(r, 3_000));
          } else {
            console.warn(`[proxy/persistence] Nonce error on attempt ${attempt + 1}, retrying with fresh order...`);
          }
          // Re-fetch order with fresh nonce
          const freshTx = await this.buildTransaction(quote);
          if (!freshTx.eip712) break;
          const freshValue = freshTx.eip712.value as Record<string, unknown>;
          const freshDomain = freshTx.eip712.domain as { name: string; chainId: number; verifyingContract: string };
          const { EIP712Domain: _fd, ...freshSigningTypes } = freshTx.eip712.types as Record<string, unknown>;
          signature = await connectedSigner.signTypedData(
            freshDomain,
            freshSigningTypes as Record<string, Array<{ name: string; type: string }>>,
            freshValue,
          );
          witness = freshValue.witness as Record<string, unknown>;
          orderTuple = buildOrderTuple(witness);
          continue;
        }
        break;
      }
    }

    if (lastError) throw lastError as Error;

    // Step 5: Submit order to Persistence backend so the solver picks it up.
    // This mirrors PersistenceBackend.signAndExecute() Step 5.
    const PERSISTENCE_API = "https://api.interop.persistence.one";
    const orderHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint32", "uint32", "uint32", "bytes"],
        orderTuple,
      ),
    );
    console.log(`[proxy/persistence] Order hash: ${orderHash}`);

    const submitPayload = {
      settlementContract: String(witness.settlementContract),
      swapper: swapperAddress,
      nonce: Number(witness.nonce),
      originChainId: sourceChainId,
      initiateDeadline: Number(witness.initiateDeadline),
      fillDeadline: Number(witness.fillDeadline),
      orderData: String(witness.orderData),
      signature,
      orderHash,
      sourceChainTxHash: initiateTx.hash,
    };

    try {
      const resp = await fetch(`${PERSISTENCE_API}/orders/submit-with-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitPayload),
      });
      if (!resp.ok) {
        console.warn(`[proxy/persistence] Backend submission returned ${resp.status}: ${await resp.text()}`);
      } else {
        console.log("[proxy/persistence] Order submitted to backend.");
      }
    } catch (err) {
      console.warn(`[proxy/persistence] Backend submission failed, retrying once: ${(err as Error).message}`);
      try {
        await new Promise((r) => setTimeout(r, 2_000));
        const resp2 = await fetch(`${PERSISTENCE_API}/orders/submit-with-tx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitPayload),
        });
        if (!resp2.ok) {
          console.warn(`[proxy/persistence] Retry submission returned ${resp2.status}`);
        } else {
          console.log("[proxy/persistence] Order submitted to backend (retry).");
        }
      } catch (retryErr) {
        console.warn(`[proxy/persistence] Retry also failed: ${(retryErr as Error).message}`);
      }
    }

    const trackingId = txRequest.trackingId;
    const orderId = trackingId.replace("persistence:", "");
    return { txHash: initiateTx.hash, orderId, trackingId };
  }

  async getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus> {
    const res = (await this.client.status(trackingId, meta)) as Record<string, unknown>;
    if (res.error) throw new Error(String(res.error));
    return res as unknown as BridgeStatus;
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    const res = (await this.client.chains()) as { chains?: ChainInfo[] };
    return res.chains ?? [];
  }

  async getSupportedTokens(chainId: number): Promise<TokenInfo[]> {
    const res = (await this.client.tokens(chainId)) as { tokens?: TokenInfo[] };
    return res.tokens ?? [];
  }
}

// ─── Proxy routing engine ─────────────────────────────────────────────────────

/**
 * Structural equivalent of RoutingEngine. Satisfies the same interface so it
 * can be passed to all MCP tool registrations via an `as unknown as RoutingEngine` cast.
 */
export class ProxyRoutingEngine {
  private client: BackendClient;
  /** Local quote cache: quoteId → { quote, expiresAt } */
  private quoteCache = new Map<string, { quote: BridgeQuote; expiresAt: number }>();
  /** Track failed providers from the last getQuotes call */
  private lastFailed: FailedProvider[] = [];
  /** Proxy backends keyed by backend name */
  private proxyBackends = new Map<string, ProxyBackend>();
  /** Shared circuit breaker (mostly a stub in proxy mode) */
  private cb = new CircuitBreaker();

  constructor(backendUrl: string) {
    this.client = new BackendClient(backendUrl);
  }

  async getQuotes(params: QuoteParams): Promise<CachedQuote[]> {
    const body = {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amountRaw,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      preference: params.preference,
      providers: params.providers,
    };

    const res = (await this.client.quote(body)) as {
      quotes?: Array<Record<string, unknown>>;
      failedProviders?: FailedProvider[];
      error?: string;
    };

    if (res.error) throw new Error(res.error);

    this.lastFailed = res.failedProviders ?? [];

    const cached: CachedQuote[] = [];
    const now = Date.now();

    for (const raw of res.quotes ?? []) {
      const quoteId = String(raw.quoteId);
      const backendName = String(raw.backendName);

      // Embed the quoteId into quoteData so ProxyBackend.buildTransaction() can retrieve it
      const quoteData = { __proxyQuoteId: quoteId };

      const quote: CachedQuote = {
        quoteId,
        backendName,
        provider: String(raw.provider),
        outputAmount: String(raw.outputAmount),
        outputAmountRaw: String(raw.outputAmountRaw),
        minOutputAmount: String(raw.minOutputAmount),
        minOutputAmountRaw: String(raw.minOutputAmountRaw),
        outputDecimals: raw.outputDecimals != null ? Number(raw.outputDecimals) : undefined,
        estimatedGasCostUsd: raw.estimatedGasCostUsd != null ? Number(raw.estimatedGasCostUsd) : null,
        estimatedFeeUsd: raw.estimatedFeeUsd != null ? Number(raw.estimatedFeeUsd) : null,
        feeBreakdown: raw.feeBreakdown as BridgeQuote["feeBreakdown"],
        estimatedTimeSeconds: Number(raw.estimatedTimeSeconds),
        route: String(raw.route),
        quoteData,
        expiresAt: Number(raw.expiresAt),
      };

      this.quoteCache.set(quoteId, { quote, expiresAt: quote.expiresAt });

      // Register a proxy backend for this provider if we haven't already
      if (!this.proxyBackends.has(backendName)) {
        this.proxyBackends.set(backendName, new ProxyBackend(backendName, this.client));
      }

      cached.push(quote);
    }

    // Evict expired entries
    for (const [id, entry] of this.quoteCache) {
      if (entry.expiresAt < now) this.quoteCache.delete(id);
    }

    return cached;
  }

  getCachedQuote(quoteId: string): BridgeQuote | null {
    const entry = this.quoteCache.get(quoteId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.quoteCache.delete(quoteId);
      return null;
    }
    return entry.quote;
  }

  getCachedQuoteWithExpiry(quoteId: string): { quote: BridgeQuote; expired: boolean } | null {
    const entry = this.quoteCache.get(quoteId);
    if (!entry) return null;
    return { quote: entry.quote, expired: entry.expiresAt < Date.now() };
  }

  getBackend(name: string): BridgeBackend | undefined {
    // Return existing proxy backend or create one on demand
    if (!this.proxyBackends.has(name)) {
      this.proxyBackends.set(name, new ProxyBackend(name, this.client));
    }
    return this.proxyBackends.get(name);
  }

  getAllBackends(): BridgeBackend[] {
    // Return a single aggregating proxy backend that handles chains/tokens
    if (this.proxyBackends.size === 0) {
      // Bootstrap with a generic "proxy" backend for chains/tokens discovery
      this.proxyBackends.set("proxy", new ProxyBackend("proxy", this.client));
    }
    return Array.from(this.proxyBackends.values());
  }

  getLastFailedProviders(): FailedProvider[] {
    return this.lastFailed;
  }

  getLastRequestDiagnosis(): { allErrored: boolean; allEmpty: boolean; circuitBroken: string[] } {
    const allErrored = this.lastFailed.length > 0 && this.lastFailed.every((f) => f.reason.includes("error"));
    const allEmpty = this.lastFailed.length > 0 && this.lastFailed.every((f) => f.reason.includes("no routes"));
    return { allErrored, allEmpty, circuitBroken: [] };
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.cb;
  }
}

export function createProxyEngine(backendUrl: string): ProxyRoutingEngine {
  return new ProxyRoutingEngine(backendUrl);
}
