/**
 * ACP-specific types for BridgeKitty integration with Virtuals Protocol's
 * Agent Commerce Protocol.
 */

// ─── Job Requirements (what the buyer sends) ─────────────────────────────────

export interface AcpBridgeRequirement {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  amount: string;
  senderAddress: string;
  recipientAddress?: string;
}

// ─── Deliverable (what we return) ─────────────────────────────────────────────

export type AcpDeliverableStatus = "success" | "no_routes" | "error";

export interface AcpQuoteInfo {
  provider: string;
  youReceiveMin: string;
  estimatedGasFee: string;
  estimatedTime: string;
  route: string;
  quoteId: string;
}

export interface AcpTransactionData {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
}

export interface AcpDeliverable {
  status: AcpDeliverableStatus;
  quote?: AcpQuoteInfo;
  transaction?: AcpTransactionData;
  approvalTx?: AcpTransactionData;
  instructions?: string;
  warnings?: string[];
  error?: string;
}

// ─── Service Offering ─────────────────────────────────────────────────────────

export interface AcpServiceOffering {
  name: string;
  description: string;
  priceUsd: number;
  requirementSchema: Record<string, string>;
  deliverableSchema: Record<string, string>;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface AcpConfig {
  /** Private key of the ACP service wallet (Wallet 1) */
  agentWalletPrivateKey: string;
  /** Smart wallet address on ACP (created via ACP platform) */
  agentWalletAddress: string;
  /** Entity ID from ACP registration */
  agentEntityId: number;
  /** Flat fee per job in USD */
  servicePriceUsd: number;
  /** Maximum concurrent jobs */
  maxConcurrentJobs: number;
  /** Timeout per job in ms */
  jobTimeoutMs: number;
  /** Integrator wallet address (Wallet 2) for backend referral fees */
  integratorWalletAddress: string;
  /** Optional custom RPC URL for Base */
  customRpcUrl?: string;
  /** Use testnet (Base Sepolia) instead of mainnet */
  useTestnet?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function loadAcpConfig(): AcpConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    agentWalletPrivateKey: required("ACP_AGENT_WALLET_PRIVATE_KEY"),
    agentWalletAddress: required("ACP_AGENT_WALLET_ADDRESS"),
    agentEntityId: parseInt(required("ACP_AGENT_ENTITY_ID"), 10),
    servicePriceUsd: parseFloat(process.env.ACP_SERVICE_PRICE_USD ?? "0.20"),
    maxConcurrentJobs: parseInt(process.env.ACP_MAX_CONCURRENT_JOBS ?? "10", 10),
    jobTimeoutMs: parseInt(process.env.ACP_JOB_TIMEOUT_MS ?? "30000", 10),
    integratorWalletAddress: process.env.INTEGRATOR_WALLET_ADDRESS ?? "0xb24aCFcda187135490d81517ab56709FdDe6a81A",
    customRpcUrl: process.env.ACP_CUSTOM_RPC_URL,
    useTestnet: process.env.ACP_USE_TESTNET === "true",
  };
}
