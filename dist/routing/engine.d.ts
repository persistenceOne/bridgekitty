import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";
import { CircuitBreaker } from "../utils/circuit-breaker.js";
export interface CachedQuote extends BridgeQuote {
    quoteId: string;
}
export declare class RoutingEngine {
    private backends;
    private quoteCache;
    private quoteResponseCache;
    private circuitBreaker;
    /** Track per-request backend outcomes for error differentiation */
    private lastRequestErrors;
    constructor(backends: BridgeBackend[], circuitBreaker?: CircuitBreaker);
    getQuotes(params: QuoteParams): Promise<CachedQuote[]>;
    getCachedQuote(quoteId: string): BridgeQuote | null;
    getBackend(name: string): BridgeBackend | undefined;
    getAllBackends(): BridgeBackend[];
    /**
     * Get the circuit breaker instance (for monitoring/testing).
     */
    getCircuitBreaker(): CircuitBreaker;
    /**
     * Differentiate why no quotes were returned.
     * Call after getQuotes returns empty to understand the cause.
     */
    getLastRequestDiagnosis(): {
        allErrored: boolean;
        allEmpty: boolean;
        circuitBroken: string[];
    };
}
