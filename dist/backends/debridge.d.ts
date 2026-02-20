import type { BridgeBackend, BridgeQuote, BridgeStatus, ChainInfo, QuoteParams, TransactionRequest } from "./types.js";
export declare class DeBridgeBackend implements BridgeBackend {
    name: string;
    private affiliateFeePercent?;
    private affiliateFeeRecipient?;
    constructor(affiliateFeePercent?: string, affiliateFeeRecipient?: string);
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
}
