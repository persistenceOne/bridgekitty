import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";
export interface CachedQuote extends BridgeQuote {
    quoteId: string;
}
export declare class RoutingEngine {
    private backends;
    private quoteCache;
    constructor(backends: BridgeBackend[]);
    getQuotes(params: QuoteParams): Promise<CachedQuote[]>;
    getCachedQuote(quoteId: string): BridgeQuote | null;
    getBackend(name: string): BridgeBackend | undefined;
    getAllBackends(): BridgeBackend[];
}
