import { ethers } from "ethers";
import type { BridgeBackend, BridgeQuote, BridgeStatus, ChainInfo, QuoteParams, TransactionRequest } from "./types.js";
import { BackendValidationError } from "./types.js";
/**
 * @deprecated Use BackendValidationError from types.ts instead.
 * Kept as re-export for backward compatibility.
 */
export declare const PersistenceValidationError: typeof BackendValidationError;
declare const PERMIT2_WITNESS_TYPES: {
    CrossChainOrder: {
        name: string;
        type: string;
    }[];
    PermitWitnessTransferFrom: {
        name: string;
        type: string;
    }[];
    TokenPermissions: {
        name: string;
        type: string;
    }[];
};
/** Prepared order data ready for signing */
export interface PreparedOrder {
    order: {
        settlementContract: string;
        swapper: string;
        nonce: bigint;
        originChainId: number;
        initiateDeadline: number;
        fillDeadline: number;
        orderData: string;
    };
    eip712Domain: {
        name: string;
        chainId: number;
        verifyingContract: string;
    };
    eip712Types: typeof PERMIT2_WITNESS_TYPES;
    eip712Value: Record<string, unknown>;
    inputToken: string;
    inputAmount: string;
    approvalTx: {
        to: string;
        data: string;
        value: string;
        chainId: number;
    };
}
export declare class PersistenceBackend implements BridgeBackend {
    name: string;
    /**
     * Validate amount against Persistence Interop caps.
     * Caps are defined in 8-decimal BTC units (MIN_AMOUNT_RAW=5000, MAX_AMOUNT_RAW=100000).
     * BTCB uses 18 decimals, cbBTC uses 8 decimals — normalize before comparing.
     */
    private validateAmount;
    getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
    /**
     * Prepare a CrossChainOrder for signing. This calls the settlement contract
     * on-chain to get a properly formed order with nonce and orderData.
     */
    prepareOrder(quote: BridgeQuote, swapperAddress: string): Promise<PreparedOrder>;
    /**
     * Build transaction data for the MCP flow (no server-side signing).
     * Calls prepareOrder() via on-chain view to get the EIP-712 typed data
     * and Permit2 approval tx that the agent/wallet must sign externally.
     *
     * Use signAndExecute() for flows where a signer (private key) is available.
     */
    buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
    /**
     * Full sign-and-execute flow for when a signer (private key) is available.
     * This is used by test scripts and the ACP listener.
     *
     * Returns the source chain tx hash and order ID for tracking.
     */
    signAndExecute(quote: BridgeQuote, signer: ethers.Wallet): Promise<{
        txHash: string;
        orderId: string;
        trackingId: string;
    }>;
    getStatus(trackingId: string, meta?: Record<string, string>): Promise<BridgeStatus>;
    getSupportedChains(): Promise<ChainInfo[]>;
}
export {};
