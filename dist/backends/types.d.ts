/**
 * Generic validation error that any backend can throw.
 * Routing engine catches these and propagates them to the tool layer
 * with user-friendly messages.
 */
export declare class BackendValidationError extends Error {
    constructor(message: string);
}
export interface QuoteParams {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amountRaw: string;
    fromAddress: string;
    toAddress?: string;
    preference: "cheapest" | "fastest";
    fromTokenDecimals?: number;
    toTokenDecimals?: number;
    /** Optional filter: only query these providers (by backend name, e.g. "lifi", "squid") */
    providers?: string[];
}
export interface FeeBreakdown {
    gasCostUsd: number | null;
    protocolFeeUsd: number;
    integratorFeeUsd: number;
    integratorFeePercent: string | null;
    totalFeeUsd: number | null;
    fixFeeNativeRaw?: string;
    operatingExpenseRaw?: string;
    totalSourceAmountRaw?: string;
}
export interface BridgeQuote {
    /** Machine-readable backend name (e.g. "lifi", "debridge") for routing/lookup */
    backendName: string;
    /** Human-readable provider description (e.g. "Stargate via LI.FI") */
    provider: string;
    outputAmount: string;
    outputAmountRaw: string;
    /** Minimum guaranteed output (after slippage/fees). Worst-case amount that lands in wallet. */
    minOutputAmount: string;
    minOutputAmountRaw: string;
    /** Number of decimals for the output token. Used to normalize cross-backend comparisons. */
    outputDecimals?: number;
    /** Estimated gas cost in USD for the on-chain transaction. null = unknown. */
    estimatedGasCostUsd: number | null;
    /** True if fallback (hardcoded) prices were used for gas estimation instead of live data */
    usingFallbackPrices?: boolean;
    estimatedFeeUsd: number | null;
    feeBreakdown: FeeBreakdown;
    estimatedTimeSeconds: number;
    route: string;
    quoteData: unknown;
    expiresAt: number;
}
export interface TransactionRequest {
    to: string;
    data: string;
    value: string;
    chainId: number;
    gasLimit?: string;
    approvalTx?: {
        to: string;
        data: string;
        value: string;
        chainId: number;
    };
    provider: string;
    trackingId: string;
    /** If true, caller must re-fetch bridge tx after approval confirms (avoids stale nonce). */
    needsPostApprovalBuild?: boolean;
    /**
     * EIP-712 typed data for backends that require off-chain signing (e.g. Persistence Interop).
     * When present, skip tx simulation — the agent must sign this data with their wallet
     * then submit the resulting signature to the backend.
     */
    eip712?: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        value: Record<string, unknown>;
        description: string;
    };
    /**
     * Solana transaction data. When present, the source chain is Solana and the agent
     * must sign/send this as a Solana transaction (not EVM).
     * `serializedTx` is a base58-encoded versioned transaction.
     */
    solanaTransaction?: {
        serializedTx: string;
    };
}
export interface BridgeStatus {
    state: "pending" | "in_progress" | "completed" | "failed" | "refunded" | "unknown";
    humanReadable: string;
    sourceTxHash?: string;
    destTxHash?: string;
    provider: string;
    elapsed: number;
    estimatedRemaining?: number;
}
export interface ChainInfo {
    id: number;
    name: string;
    key: string;
    logoURI?: string;
    providers: string[];
}
export interface TokenInfo {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    chainId: number;
    logoURI?: string;
}
export interface BridgeBackend {
    name: string;
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    /** Return multiple route options. Default implementation wraps getQuote. */
    getQuotes?(params: QuoteParams): Promise<BridgeQuote[]>;
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
    getSupportedTokens?(chainId: number): Promise<TokenInfo[]>;
}
