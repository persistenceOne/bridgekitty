import crypto from "node:crypto";
import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";
import { BackendValidationError } from "../backends/types.js";
import { isValidEvmAddress } from "../utils/evm.js";
import { CircuitBreaker } from "../utils/circuit-breaker.js";
import { getAllChains } from "../utils/chains.js";

export interface CachedQuote extends BridgeQuote {
  quoteId: string;
}

/** Minimum buffer (ms) before a quote's expiry — quotes expiring within this window are filtered out. */
const EXPIRY_BUFFER_MS = 5_000;

/** Timeout for each backend quote request (ms). */
const BACKEND_TIMEOUT_MS = 10_000;

/** Quote response cache TTL (ms). Same params within this window return cached results. */
const QUOTE_CACHE_TTL_MS = 15_000;

/**
 * Validate quote params before sending to any backend.
 * Throws BackendValidationError for invalid inputs.
 */
function validateQuoteParams(params: QuoteParams): void {
  // Chain IDs must be positive integers
  if (!Number.isInteger(params.fromChainId) || params.fromChainId <= 0) {
    throw new BackendValidationError(
      `Invalid source chain ID: ${params.fromChainId}. Must be a positive integer.`
    );
  }
  if (!Number.isInteger(params.toChainId) || params.toChainId <= 0) {
    throw new BackendValidationError(
      `Invalid destination chain ID: ${params.toChainId}. Must be a positive integer.`
    );
  }

  // Cannot bridge to same chain
  if (params.fromChainId === params.toChainId) {
    throw new BackendValidationError(
      `Source and destination chains are the same (${params.fromChainId}). Use a DEX for same-chain swaps.`
    );
  }

  // Amount must be positive
  let amountBig: bigint;
  try {
    amountBig = BigInt(params.amountRaw);
  } catch {
    throw new BackendValidationError(
      `Invalid amount: "${params.amountRaw}" is not a valid number.`
    );
  }
  if (amountBig <= 0n) {
    throw new BackendValidationError(
      `Amount must be positive. Got: ${params.amountRaw}`
    );
  }

  // fromAddress must be valid EVM address
  if (!isValidEvmAddress(params.fromAddress)) {
    throw new BackendValidationError(
      `Invalid sender address: "${params.fromAddress}". Expected 0x followed by 40 hex characters.`
    );
  }

  // toAddress, if provided, must be valid
  if (params.toAddress && !isValidEvmAddress(params.toAddress)) {
    throw new BackendValidationError(
      `Invalid recipient address: "${params.toAddress}". Expected 0x followed by 40 hex characters.`
    );
  }

  // Token addresses: must look like addresses (0x...) — we allow symbols at the tool layer,
  // but by the time they reach the engine they should be resolved
  if (!isValidEvmAddress(params.fromTokenAddress)) {
    throw new BackendValidationError(
      `Invalid source token address: "${params.fromTokenAddress}". Provide a valid 0x address or a recognized token symbol.`
    );
  }
  if (!isValidEvmAddress(params.toTokenAddress)) {
    throw new BackendValidationError(
      `Invalid destination token address: "${params.toTokenAddress}". Provide a valid 0x address or a recognized token symbol.`
    );
  }
}

/**
 * Normalize a chain identifier for cache key consistency.
 * Ensures "bsc", "56", "BSC" all produce the same cache key component.
 * Since the engine already resolves chain IDs to numbers before reaching here,
 * this is mainly for defensive normalization.
 */
function normalizeChainForCache(chainId: number): string {
  return String(chainId);
}

/**
 * Build a cache key from normalized quote params.
 * All addresses are lowercased and chain IDs are stringified for consistency.
 */
function buildQuoteCacheKey(params: QuoteParams): string {
  return [
    normalizeChainForCache(params.fromChainId),
    normalizeChainForCache(params.toChainId),
    params.fromTokenAddress.toLowerCase(),
    params.toTokenAddress.toLowerCase(),
    params.amountRaw,
    params.preference,
  ].join(":");
}

interface QuoteResponseCacheEntry {
  quotes: CachedQuote[];
  fetchedAt: number;
}

export class RoutingEngine {
  private backends: BridgeBackend[];
  private quoteCache = new Map<string, { quote: BridgeQuote; expiresAt: number }>();
  private quoteResponseCache = new Map<string, QuoteResponseCacheEntry>();
  private circuitBreaker: CircuitBreaker;
  /** Track per-request backend outcomes for error differentiation */
  private lastRequestErrors = new Map<string, "error" | "empty" | "success">();

  constructor(backends: BridgeBackend[], circuitBreaker?: CircuitBreaker) {
    this.backends = backends;
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
  }

  async getQuotes(params: QuoteParams): Promise<CachedQuote[]> {
    // Validate inputs before calling any backend
    validateQuoteParams(params);

    // Validate chain IDs against known supported chains (NEW-LOW-003)
    const supportedChains = getAllChains();
    const supportedIds = supportedChains.map((c) => c.id);
    const supportedList = supportedChains.map((c) => `${c.name} (${c.id})`).join(", ");
    if (!supportedIds.includes(params.fromChainId)) {
      throw new BackendValidationError(
        `Unsupported source chain ID: ${params.fromChainId}. Supported chains: ${supportedList}`
      );
    }
    if (!supportedIds.includes(params.toChainId)) {
      throw new BackendValidationError(
        `Unsupported destination chain ID: ${params.toChainId}. Supported chains: ${supportedList}`
      );
    }

    // Check quote response cache
    const cacheKey = buildQuoteCacheKey(params);
    const cached = this.quoteResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
      // Return cached quotes that haven't expired
      const now = Date.now();
      const valid = cached.quotes.filter((q) => q.expiresAt > now + EXPIRY_BUFFER_MS);
      if (valid.length > 0) return valid;
    }

    // Reset error tracking for this request
    this.lastRequestErrors.clear();

    // Filter backends by circuit breaker state
    const allowedBackends = this.backends.filter((b) => {
      const allowed = this.circuitBreaker.isAllowed(b.name);
      if (!allowed) {
        this.lastRequestErrors.set(b.name, "error"); // circuit-broken = effectively errored
      }
      return allowed;
    });

    // Use getQuotes (multi-route) when available, fall back to getQuote (single)
    const results = await Promise.allSettled(
      allowedBackends.map((b) =>
        Promise.race([
          (b.getQuotes
            ? b.getQuotes(params)
            : b.getQuote(params).then((q) => (q ? [q] : []))
          ).then((quotes) => ({ backendName: b.name, quotes })),
          new Promise<{ backendName: string; quotes: BridgeQuote[] }>((resolve) =>
            setTimeout(() => resolve({ backendName: b.name, quotes: [] }), BACKEND_TIMEOUT_MS)
          ),
        ])
      )
    );

    // Check for validation errors from backends and propagate the first one
    for (const r of results) {
      if (r.status === "rejected" && r.reason instanceof BackendValidationError) {
        throw r.reason;
      }
    }

    const now = Date.now();

    // Process results and track circuit breaker state
    const allQuotes: BridgeQuote[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const backendName = allowedBackends[i].name;

      if (r.status === "rejected") {
        this.circuitBreaker.recordFailure(backendName);
        this.lastRequestErrors.set(backendName, "error");
        continue;
      }

      const quotes = r.value.quotes.filter((q): q is BridgeQuote => q !== null);
      if (quotes.length === 0) {
        // Empty result is not a failure for circuit breaker (route might not exist)
        this.circuitBreaker.recordSuccess(backendName);
        this.lastRequestErrors.set(backendName, "empty");
      } else {
        this.circuitBreaker.recordSuccess(backendName);
        this.lastRequestErrors.set(backendName, "success");
        allQuotes.push(...quotes);
      }
    }

    // Filter expired quotes (with buffer)
    const validQuotes = allQuotes.filter((q) => q.expiresAt > now + EXPIRY_BUFFER_MS);

    // Sort by preference
    if (params.preference === "fastest") {
      validQuotes.sort((a, b) => a.estimatedTimeSeconds - b.estimatedTimeSeconds);
    } else {
      // Cheapest = highest output amount (BigInt raw), with gas as tiebreaker
      // (NEW-MEDIUM-001: don't mix token units with USD gas costs)
      validQuotes.sort((a, b) => {
        try {
          const aOutputRaw = BigInt(a.minOutputAmountRaw);
          const bOutputRaw = BigInt(b.minOutputAmountRaw);

          // Normalize to 18 decimals for cross-backend comparison (V3-MEDIUM-001)
          const aOutput = aOutputRaw * 10n ** BigInt(18 - (a.outputDecimals ?? 18));
          const bOutput = bOutputRaw * 10n ** BigInt(18 - (b.outputDecimals ?? 18));

          // Primary sort: highest output wins
          // Use gas as tiebreaker only when outputs are within 0.1% of each other
          const larger = aOutput > bOutput ? aOutput : bOutput;
          const diff = aOutput > bOutput ? aOutput - bOutput : bOutput - aOutput;
          const isNearEqual = larger > 0n && diff * 1000n <= larger; // within 0.1%

          if (!isNearEqual) {
            // Outputs differ meaningfully — highest output wins
            return bOutput > aOutput ? 1 : bOutput < aOutput ? -1 : 0;
          }

          // Outputs are near-equal — use gas cost as tiebreaker (lower gas wins)
          const aGas = a.estimatedGasCostUsd ?? Infinity;
          const bGas = b.estimatedGasCostUsd ?? Infinity;
          if (aGas !== bGas) return aGas - bGas;

          // Gas also equal — fall back to raw output
          return bOutput > aOutput ? 1 : bOutput < aOutput ? -1 : 0;
        } catch {
          return 0;
        }
      });
    }

    // Cache quotes for execution and assign stable IDs
    const cachedQuotes: CachedQuote[] = [];
    for (const q of validQuotes) {
      const quoteId = crypto.randomUUID();
      this.quoteCache.set(quoteId, { quote: q, expiresAt: q.expiresAt });
      cachedQuotes.push({ ...q, quoteId });
    }

    // Store in response cache
    this.quoteResponseCache.set(cacheKey, { quotes: cachedQuotes, fetchedAt: now });

    // Clean expired entries
    for (const [key, val] of this.quoteCache) {
      if (val.expiresAt < now) this.quoteCache.delete(key);
    }
    // Clean old response cache entries
    for (const [key, val] of this.quoteResponseCache) {
      if (now - val.fetchedAt > QUOTE_CACHE_TTL_MS) this.quoteResponseCache.delete(key);
    }

    return cachedQuotes;
  }

  getCachedQuote(quoteId: string): BridgeQuote | null {
    const entry = this.quoteCache.get(quoteId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.quoteCache.delete(quoteId);
      return null;
    }
    return entry.quote;
  }

  getBackend(name: string): BridgeBackend | undefined {
    return this.backends.find((b) => b.name === name);
  }

  getAllBackends(): BridgeBackend[] {
    return this.backends;
  }

  /**
   * Get the circuit breaker instance (for monitoring/testing).
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Differentiate why no quotes were returned.
   * Call after getQuotes returns empty to understand the cause.
   */
  getLastRequestDiagnosis(): { allErrored: boolean; allEmpty: boolean; circuitBroken: string[] } {
    const outcomes = Array.from(this.lastRequestErrors.values());
    const circuitBroken: string[] = [];
    for (const [name] of this.lastRequestErrors) {
      if (this.circuitBreaker.getState(name) === "OPEN") {
        circuitBroken.push(name);
      }
    }

    return {
      allErrored: outcomes.length > 0 && outcomes.every((o) => o === "error"),
      allEmpty: outcomes.length > 0 && outcomes.every((o) => o === "empty" || o === "success"),
      circuitBroken,
    };
  }
}
