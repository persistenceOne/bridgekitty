import type { BridgeBackend, BridgeQuote, BridgeStatus, ChainInfo, QuoteParams, TransactionRequest } from "./types.js";
export declare class AcrossBackend implements BridgeBackend {
    name: string;
    private referrer?;
    constructor(referrer?: string);
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
}
