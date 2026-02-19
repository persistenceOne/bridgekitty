import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";
export declare class RoutingEngine {
    private backends;
    private quoteCache;
    constructor(backends: BridgeBackend[]);
    getQuotes(params: QuoteParams): Promise<BridgeQuote[]>;
    getCachedQuote(cacheKey: string): BridgeQuote | null;
    getBackend(name: string): BridgeBackend | undefined;
    getAllBackends(): BridgeBackend[];
}
