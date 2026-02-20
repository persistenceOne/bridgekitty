import type { BridgeBackend, BridgeQuote, BridgeStatus, ChainInfo, QuoteParams, TokenInfo, TransactionRequest } from "./types.js";
export declare class LiFiBackend implements BridgeBackend {
    name: string;
    private apiKey?;
    private integrator?;
    private integratorFee?;
    constructor(apiKey?: string, integrator?: string, integratorFee?: string);
    private headers;
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    /**
     * Fetch multiple routes via LI.FI /advanced/routes endpoint.
     * Returns up to 5 route options with full fee breakdowns.
     */
    getQuotes(params: QuoteParams): Promise<BridgeQuote[]>;
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
    getSupportedTokens(chainId: number): Promise<TokenInfo[]>;
}
