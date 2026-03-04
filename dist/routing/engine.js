import crypto from "node:crypto";
import { BackendValidationError } from "../backends/types.js";
import { isValidEvmAddress } from "../utils/evm.js";
import { CircuitBreaker } from "../utils/circuit-breaker.js";
import { getAllChains, isCosmosChain } from "../utils/chains.js";
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
function validateQuoteParams(params) {
    // Chain IDs must be positive integers
    if (!Number.isInteger(params.fromChainId) || params.fromChainId <= 0) {
        throw new BackendValidationError(`Invalid source chain ID: ${params.fromChainId}. Must be a positive integer.`);
    }
    if (!Number.isInteger(params.toChainId) || params.toChainId <= 0) {
        throw new BackendValidationError(`Invalid destination chain ID: ${params.toChainId}. Must be a positive integer.`);
    }
    // Cannot bridge to same chain
    if (params.fromChainId === params.toChainId) {
        throw new BackendValidationError(`Source and destination chains are the same (${params.fromChainId}). Use a DEX for same-chain swaps.`);
    }
    // Amount must be positive
    let amountBig;
    try {
        amountBig = BigInt(params.amountRaw);
    }
    catch {
        throw new BackendValidationError(`Invalid amount: "${params.amountRaw}" is not a valid number.`);
    }
    if (amountBig <= 0n) {
        throw new BackendValidationError(`Amount must be positive. Got: ${params.amountRaw}`);
    }
    // Determine if source/destination are Cosmos chains (relaxed address validation)
    const fromIsCosmos = isCosmosChain(params.fromChainId);
    const toIsCosmos = isCosmosChain(params.toChainId);
    // fromAddress must be valid EVM address (unless destination is Cosmos-only route)
    if (!fromIsCosmos && !isValidEvmAddress(params.fromAddress)) {
        throw new BackendValidationError(`Invalid sender address: "${params.fromAddress}". Expected 0x followed by 40 hex characters.`);
    }
    // toAddress, if provided, must be valid (relaxed for Cosmos bech32 addresses)
    if (params.toAddress && !toIsCosmos && !isValidEvmAddress(params.toAddress)) {
        throw new BackendValidationError(`Invalid recipient address: "${params.toAddress}". Expected 0x followed by 40 hex characters.`);
    }
    // Token addresses: must look like EVM addresses (0x...) or Cosmos denoms (e.g. "uxprt", "uatom")
    // Cosmos denoms are lowercase alphanumeric strings (no 0x prefix)
    const isValidTokenAddress = (addr, chainIsCosmos) => {
        if (isValidEvmAddress(addr))
            return true;
        if (chainIsCosmos && /^[a-z][a-z0-9/]{1,128}$/.test(addr))
            return true;
        return false;
    };
    if (!isValidTokenAddress(params.fromTokenAddress, fromIsCosmos)) {
        throw new BackendValidationError(`Invalid source token address: "${params.fromTokenAddress}". Provide a valid 0x address or a recognized token symbol.`);
    }
    if (!isValidTokenAddress(params.toTokenAddress, toIsCosmos)) {
        throw new BackendValidationError(`Invalid destination token address: "${params.toTokenAddress}". Provide a valid 0x address or a recognized token symbol.`);
    }
}
/**
 * Normalize a chain identifier for cache key consistency.
 * Ensures "bsc", "56", "BSC" all produce the same cache key component.
 * Since the engine already resolves chain IDs to numbers before reaching here,
 * this is mainly for defensive normalization.
 */
function normalizeChainForCache(chainId) {
    return String(chainId);
}
/**
 * Build a cache key from normalized quote params.
 * All addresses are lowercased and chain IDs are stringified for consistency.
 */
function buildQuoteCacheKey(params) {
    return [
        normalizeChainForCache(params.fromChainId),
        normalizeChainForCache(params.toChainId),
        params.fromTokenAddress.toLowerCase(),
        params.toTokenAddress.toLowerCase(),
        params.amountRaw,
        params.fromAddress.toLowerCase(),
        params.preference,
    ].join(":");
}
export class RoutingEngine {
    backends;
    quoteCache = new Map();
    quoteResponseCache = new Map();
    circuitBreaker;
    /** Track per-request backend outcomes for error differentiation */
    lastRequestErrors = new Map();
    /** Track per-request backend failure reasons */
    lastFailedProviders = [];
    constructor(backends, circuitBreaker) {
        this.backends = backends;
        this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
    }
    async getQuotes(params) {
        // Validate inputs before calling any backend
        validateQuoteParams(params);
        // Validate chain IDs against known supported chains (NEW-LOW-003)
        const supportedChains = getAllChains();
        const supportedIds = supportedChains.map((c) => c.id);
        const supportedList = supportedChains.map((c) => `${c.name} (${c.id})`).join(", ");
        if (!supportedIds.includes(params.fromChainId)) {
            throw new BackendValidationError(`Unsupported source chain ID: ${params.fromChainId}. Supported chains: ${supportedList}`);
        }
        if (!supportedIds.includes(params.toChainId)) {
            throw new BackendValidationError(`Unsupported destination chain ID: ${params.toChainId}. Supported chains: ${supportedList}`);
        }
        // Check quote response cache
        const cacheKey = buildQuoteCacheKey(params);
        const cached = this.quoteResponseCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
            // Return cached quotes that haven't expired
            const now = Date.now();
            const valid = cached.quotes.filter((q) => q.expiresAt > now + EXPIRY_BUFFER_MS);
            if (valid.length > 0)
                return valid;
        }
        // Reset error tracking for this request
        this.lastRequestErrors.clear();
        this.lastFailedProviders = [];
        // Filter backends by providers filter (if specified)
        let eligibleBackends = this.backends;
        if (params.providers && params.providers.length > 0) {
            const allowed = new Set(params.providers.map(p => p.toLowerCase()));
            eligibleBackends = this.backends.filter((b) => allowed.has(b.name.toLowerCase()));
            // Track filtered-out providers
            for (const b of this.backends) {
                if (!allowed.has(b.name.toLowerCase())) {
                    this.lastFailedProviders.push({ provider: b.name, reason: "filtered out by providers parameter" });
                }
            }
        }
        // Filter backends by circuit breaker state
        const allowedBackends = eligibleBackends.filter((b) => {
            const allowed = this.circuitBreaker.isAllowed(b.name);
            if (!allowed) {
                this.lastRequestErrors.set(b.name, "error"); // circuit-broken = effectively errored
                this.lastFailedProviders.push({ provider: b.name, reason: "circuit breaker open (too many recent failures)" });
            }
            return allowed;
        });
        // Use getQuotes (multi-route) when available, fall back to getQuote (single)
        const results = await Promise.allSettled(allowedBackends.map((b) => Promise.race([
            (b.getQuotes
                ? b.getQuotes(params)
                : b.getQuote(params).then((q) => (q ? [q] : []))).then((quotes) => ({ backendName: b.name, quotes })),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Backend ${b.name} timed out after ${BACKEND_TIMEOUT_MS}ms`)), BACKEND_TIMEOUT_MS)),
        ])));
        // Check for validation errors from backends and propagate the first one
        for (const r of results) {
            if (r.status === "rejected" && r.reason instanceof BackendValidationError) {
                throw r.reason;
            }
        }
        const now = Date.now();
        // Process results and track circuit breaker state
        const allQuotes = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const backendName = allowedBackends[i].name;
            if (r.status === "rejected") {
                this.circuitBreaker.recordFailure(backendName);
                this.lastRequestErrors.set(backendName, "error");
                const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
                // Classify the error
                let reason = "unknown error";
                if (errMsg.includes("timed out"))
                    reason = `timeout after ${BACKEND_TIMEOUT_MS / 1000}s`;
                else if (errMsg.includes("rate limit") || errMsg.includes("429"))
                    reason = "rate limited";
                else if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND"))
                    reason = "connection failed";
                else
                    reason = errMsg.slice(0, 100);
                this.lastFailedProviders.push({ provider: backendName, reason });
                continue;
            }
            const quotes = r.value.quotes.filter((q) => q !== null);
            if (quotes.length === 0) {
                // Empty result is not a failure for circuit breaker (route might not exist)
                this.circuitBreaker.recordSuccess(backendName);
                this.lastRequestErrors.set(backendName, "empty");
                this.lastFailedProviders.push({ provider: backendName, reason: "no routes for this token pair" });
            }
            else {
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
        }
        else {
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
                    if (aGas !== bGas)
                        return aGas - bGas;
                    // Gas also equal — fall back to raw output
                    return bOutput > aOutput ? 1 : bOutput < aOutput ? -1 : 0;
                }
                catch {
                    return 0;
                }
            });
        }
        // Cache quotes for execution and assign stable IDs
        const cachedQuotes = [];
        for (const q of validQuotes) {
            const quoteId = crypto.randomUUID();
            this.quoteCache.set(quoteId, { quote: q, expiresAt: q.expiresAt });
            cachedQuotes.push({ ...q, quoteId });
        }
        // Store in response cache
        this.quoteResponseCache.set(cacheKey, { quotes: cachedQuotes, fetchedAt: now });
        // Clean expired entries
        for (const [key, val] of this.quoteCache) {
            if (val.expiresAt < now)
                this.quoteCache.delete(key);
        }
        // Clean old response cache entries
        for (const [key, val] of this.quoteResponseCache) {
            if (now - val.fetchedAt > QUOTE_CACHE_TTL_MS)
                this.quoteResponseCache.delete(key);
        }
        return cachedQuotes;
    }
    getCachedQuote(quoteId) {
        const entry = this.quoteCache.get(quoteId);
        if (!entry || entry.expiresAt < Date.now()) {
            this.quoteCache.delete(quoteId);
            return null;
        }
        return entry.quote;
    }
    getBackend(name) {
        return this.backends.find((b) => b.name === name);
    }
    getAllBackends() {
        return this.backends;
    }
    /**
     * Get the circuit breaker instance (for monitoring/testing).
     */
    getCircuitBreaker() {
        return this.circuitBreaker;
    }
    /**
     * Get the list of providers that failed or returned no results in the last request.
     */
    getLastFailedProviders() {
        return this.lastFailedProviders;
    }
    /**
     * Differentiate why no quotes were returned.
     * Call after getQuotes returns empty to understand the cause.
     */
    getLastRequestDiagnosis() {
        const outcomes = Array.from(this.lastRequestErrors.values());
        const circuitBroken = [];
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
