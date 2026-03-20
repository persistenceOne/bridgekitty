/**
 * ProxyRoutingEngine — drop-in replacement for RoutingEngine when
 * BRIDGEKITTY_BACKEND_URL is set. Proxies all calls to the hosted backend.
 *
 * Usage in src/index.ts:
 *   const engine = backendUrl
 *     ? createProxyEngine(backendUrl) as unknown as RoutingEngine
 *     : createEngine();
 */

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
