export interface QuoteParams {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  amountRaw: string;
  fromAddress: string;
  toAddress?: string;
  preference: "cheapest" | "fastest";
}

export interface FeeBreakdown {
  gasCostUsd: number;
  protocolFeeUsd: number;
  integratorFeeUsd: number;
  integratorFeePercent: string | null; // e.g. "0.3%" or null if none
  totalFeeUsd: number;
}

export interface BridgeQuote {
  provider: string;
  outputAmount: string;
  outputAmountRaw: string;
  estimatedFeeUsd: number;
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
  approvalTx?: { to: string; data: string; value: string; chainId: number };
  provider: string;
  trackingId: string;
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
