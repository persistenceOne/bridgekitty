import type { BridgeBackend, BridgeQuote, BridgeStatus, ChainInfo, QuoteParams, TokenInfo, TransactionRequest } from "./types.js";
export declare class LiFiBackend implements BridgeBackend {
    name: string;
    private apiKey?;
    constructor(apiKey?: string);
    private headers;
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
    getSupportedTokens(chainId: number): Promise<TokenInfo[]>;
}
