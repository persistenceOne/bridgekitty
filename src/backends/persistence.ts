import { ethers } from "ethers";
import type {
  BridgeBackend,
  BridgeQuote,
  BridgeStatus,
  ChainInfo,
  QuoteParams,
  TransactionRequest,
} from "./types.js";
import { BackendValidationError } from "./types.js";
import { formatTokenAmount } from "../utils/tokens.js";
import { estimateGasCostUsd, getGasUnits, getProvider } from "../utils/gas-estimator.js";
import { sanitizeError } from "../utils/sanitize-error.js";

/**
 * @deprecated Use BackendValidationError from types.ts instead.
 * Kept as re-export for backward compatibility.
 */
export const PersistenceValidationError = BackendValidationError;

const BASE_URL = "https://api.interop.persistence.one";
const TIMEOUT_MS = 15_000;

// Contract addresses (same on Base 8453 and BSC 56)
const SETTLEMENT_CONTRACT = "0x5e53703b62472c336D2d7963e789b911cFafFeA7";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// ABI fragments for settlement contract
const SETTLEMENT_ABI = [
  "function prepareCrossChainOrder(address inputToken, uint256 inputAmount, address outputToken, uint256 outputAmount, address recipientAddress, uint32 destinationChainId, uint32 initiateDeadline, uint32 fillDeadline) external view returns (tuple(address settlementContract, address swapper, uint256 nonce, uint32 originChainId, uint32 initiateDeadline, uint32 fillDeadline, bytes orderData))",
  "function initiate(tuple(address settlementContract, address swapper, uint256 nonce, uint32 originChainId, uint32 initiateDeadline, uint32 fillDeadline, bytes orderData) order, bytes signature, bytes fillerData) external",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// EIP-712 types for Permit2 witness signing
const PERMIT2_DOMAIN = {
  name: "Permit2",
  chainId: 0, // set dynamically
  verifyingContract: PERMIT2_ADDRESS,
};

// The witness type for CrossChainOrder
const CROSS_CHAIN_ORDER_TYPE = {
  CrossChainOrder: [
    { name: "settlementContract", type: "address" },
    { name: "swapper", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "originChainId", type: "uint32" },
    { name: "initiateDeadline", type: "uint32" },
    { name: "fillDeadline", type: "uint32" },
    { name: "orderData", type: "bytes" },
  ],
};

// Full Permit2 PermitTransferFrom + witness types
const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "CrossChainOrder" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  ...CROSS_CHAIN_ORDER_TYPE,
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
  approvalTx: { to: string; data: string; value: string; chainId: number };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Persistence ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Persistence Interop currently supports BTC variants on Base and BSC
const SUPPORTED_CHAINS = [
  { id: 8453, name: "Base", key: "base" },
  { id: 56, name: "BNB Chain", key: "bsc" },
];

// Amount caps in raw units (8-decimal BTC): 0.000045–0.001 BTC = 4500–100000
// MIN is set slightly below 0.00005 (5000) to allow return-leg fills after solver fees (~0.5%).
// The xprt-farm tool uses 5000 as the minimum to START a round, but the backend accepts 4500
// so that the return leg can proceed with the solver's output (which is slightly less than input).
const MIN_AMOUNT_RAW = 4500n;
const MAX_AMOUNT_RAW = 100000n;
const MAX_QUOTES_RETURNED = 10;

// Supported BTC token addresses
const BTC_TOKENS: Record<number, { address: string; symbol: string }> = {
  8453: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC" },
  56: { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB" },
};

export class PersistenceBackend implements BridgeBackend {
  name = "persistence";

  /**
   * Validate amount against Persistence Interop caps.
   * Caps are defined in 8-decimal BTC units (MIN_AMOUNT_RAW=5000, MAX_AMOUNT_RAW=100000).
   * BTCB uses 18 decimals, cbBTC uses 8 decimals — normalize before comparing.
   */
  private validateAmount(amountRaw: string, fromChainId: number): void {
    let amt: bigint;
    try {
      amt = BigInt(amountRaw);
    } catch {
      throw new BackendValidationError(`Invalid amount: "${amountRaw}" is not a valid number`);
    }
    if (amt <= 0n) {
      throw new BackendValidationError(
        `Amount must be positive. Got: ${amountRaw}`
      );
    }

    // Normalize to 8-decimal BTC for cap comparison
    // BTCB (BSC, chain 56) = 18 decimals, cbBTC (Base, chain 8453) = 8 decimals
    const fromToken = BTC_TOKENS[fromChainId];
    const fromDecimals = fromToken?.symbol === "BTCB" ? 18 : 8;
    const normalized = fromDecimals > 8 ? amt / (10n ** BigInt(fromDecimals - 8)) : amt;

    if (normalized < MIN_AMOUNT_RAW) {
      throw new BackendValidationError(
        `Amount too small (${amountRaw} raw, ~${Number(normalized) / 1e8} BTC). Minimum is 0.000045 BTC.`
      );
    }
    if (normalized > MAX_AMOUNT_RAW) {
      throw new BackendValidationError(
        `Amount too large (${amountRaw} raw, ~${Number(normalized) / 1e8} BTC). Maximum is 0.001 BTC.`
      );
    }
  }

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    try {
      // Only support BTC cross-chain between Base and BSC
      const fromBtc = BTC_TOKENS[params.fromChainId];
      const toBtc = BTC_TOKENS[params.toChainId];
      if (!fromBtc || !toBtc) return null;

      // Check if the from token matches our supported BTC variant (address or symbol)
      const fromAddr = params.fromTokenAddress.toLowerCase();
      if (
        fromAddr !== fromBtc.address.toLowerCase() &&
        fromAddr !== fromBtc.symbol.toLowerCase()
      ) {
        return null;
      }

      // Check if the to token matches our supported BTC variant
      const toAddr = params.toTokenAddress.toLowerCase();
      if (
        toAddr !== toBtc.address.toLowerCase() &&
        toAddr !== toBtc.symbol.toLowerCase()
      ) {
        return null;
      }

      // BUG-001 & BUG-002: Validate amount caps and reject zero/negative
      this.validateAmount(params.amountRaw, params.fromChainId);

      const data = await fetchJson(`${BASE_URL}/quotes/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: params.fromChainId,
          destinationChainId: params.toChainId,
          sourceAsset: fromBtc.address,
          destinationAsset: toBtc.address,
          sourceAmount: params.amountRaw,
        }),
      });

      // API returns {quotes: [...]} or an array
      const allQuotes = Array.isArray(data) ? data : (data.quotes ?? [data]);
      if (!allQuotes.length || allQuotes[0]?.error) return null;

      // Filter out expired quotes (OBSERVATION-001 & OBSERVATION-002)
      const now = Date.now();
      const validQuotes = allQuotes.filter((q: any) => {
        if (!q.expirationTime) return true;
        const expiry = new Date(q.expirationTime).getTime();
        return expiry > now;
      });

      if (!validQuotes.length) return null;

      // Sort by best output and take top N (OBSERVATION-001: reduce 300+ to best 10)
      validQuotes.sort((a: any, b: any) => {
        try {
          const diff = BigInt(b.estimatedDestinationAmount ?? "0") - BigInt(a.estimatedDestinationAmount ?? "0");
          return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        } catch { return 0; }
      });
      const topQuotes = validQuotes.slice(0, Number(MAX_QUOTES_RETURNED));

      const best = topQuotes[0];
      const dstDecimals = toBtc.symbol === "BTCB" ? 18 : 8;
      const outputRaw = best.estimatedDestinationAmount ?? "0";
      const feeUsd = 0;

      // Estimate source chain gas cost (chain-aware)
      const gasUnits = getGasUnits("persistence", params.fromChainId);
      const gasEstimate = await estimateGasCostUsd(params.fromChainId, gasUnits);
      const gasCostUsd = gasEstimate?.costUsd ?? null;

      // Solver-based: apply 0.5% slippage for min output
      let minOutputRaw: string;
      try {
        const outputBig = BigInt(outputRaw);
        minOutputRaw = (outputBig * 995n / 1000n).toString();
      } catch {
        minOutputRaw = outputRaw;
      }

      return {
        backendName: "persistence",
        provider: "Persistence Interop (direct)",
        outputAmount: formatTokenAmount(outputRaw, dstDecimals),
        outputAmountRaw: outputRaw,
        minOutputAmount: formatTokenAmount(minOutputRaw, dstDecimals),
        minOutputAmountRaw: minOutputRaw,
        outputDecimals: dstDecimals,
        estimatedGasCostUsd: gasCostUsd,
        usingFallbackPrices: gasEstimate?.usingFallbackPrices,
        estimatedFeeUsd: gasCostUsd !== null ? feeUsd + gasCostUsd : null,
        feeBreakdown: {
          gasCostUsd,
          protocolFeeUsd: feeUsd,
          integratorFeeUsd: 0,
          integratorFeePercent: null,
          totalFeeUsd: gasCostUsd !== null ? feeUsd + gasCostUsd : null,
        },
        estimatedTimeSeconds: 10,
        route: `${fromBtc.symbol} → Persistence Solver → ${toBtc.symbol}`,
        quoteData: {
          ...best,
          // Stash params needed for buildTransaction/signAndExecute
          sourceChainId: params.fromChainId,
          destinationChainId: params.toChainId,
          sourceAmount: params.amountRaw,
          fromAddress: params.fromAddress,
        },
        expiresAt: best.expirationTime ? new Date(best.expirationTime).getTime() : Date.now() + 60_000,
        _meta: {
          totalQuotesFromSolver: allQuotes.length,
          expiredFiltered: allQuotes.length - validQuotes.length,
          returnedAfterFilter: topQuotes.length,
        },
      } as BridgeQuote & { _meta: any };
    } catch (err) {
      if (err instanceof BackendValidationError) {
        throw err; // Let validation errors propagate
      }
      console.error("[persistence] quote error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Prepare a CrossChainOrder for signing. This calls the settlement contract
   * on-chain to get a properly formed order with nonce and orderData.
   */
  async prepareOrder(
    quote: BridgeQuote,
    swapperAddress: string,
  ): Promise<PreparedOrder> {
    const data = quote.quoteData as any;
    const sourceChainId = data.sourceChainId ?? data.chainId ?? 8453;
    const destChainId = data.destinationChainId ?? data.destChainId ?? 56;

    const fromBtc = BTC_TOKENS[sourceChainId];
    const toBtc = BTC_TOKENS[destChainId];
    if (!fromBtc || !toBtc) {
      throw new Error(`Unsupported chain pair: ${sourceChainId} → ${destChainId}`);
    }

    const provider = await getProvider(sourceChainId);
    const settlement = new ethers.Contract(SETTLEMENT_CONTRACT, SETTLEMENT_ABI, provider);

    const now = Math.floor(Date.now() / 1000);
    const initiateDeadline = now + 300; // 5 minutes (allows slow RPC confirmation)
    const fillDeadline = now + 1800; // 30 minutes (tightened from 2h — fills take <30s)

    const inputAmount = data.sourceAmount;
    if (!inputAmount) throw new Error(`Missing sourceAmount in quote data`);
    // MEDIUM-001: Use slippage-adjusted minOutputRaw instead of raw estimatedDestinationAmount
    const rawOutputAmount = data.estimatedDestinationAmount ?? data.outputAmount;
    if (!rawOutputAmount) throw new Error(`Missing output amount in quote data`);

    // Validate output is reasonable (at least 95% of input for same-asset cross-chain)
    try {
      const inputBig = BigInt(inputAmount);
      const outputBig = BigInt(rawOutputAmount);
      // Normalize to same decimals for comparison
      const fromDecimals = BTC_TOKENS[sourceChainId]?.symbol === "BTCB" ? 18 : 8;
      const toDecimals = BTC_TOKENS[destChainId]?.symbol === "BTCB" ? 18 : 8;
      const normalizedInput = fromDecimals > toDecimals
        ? inputBig / (10n ** BigInt(fromDecimals - toDecimals))
        : inputBig * (10n ** BigInt(toDecimals - fromDecimals));
      const minAcceptable = normalizedInput * 95n / 100n;
      if (outputBig < minAcceptable) {
        throw new Error(
          `Solver output too low: ${rawOutputAmount} is less than 95% of input (${normalizedInput.toString()}). Possible manipulation.`
        );
      }
    } catch (e) {
      if ((e as Error).message.includes("Solver output too low")) throw e;
      // If BigInt conversion fails, continue with the raw amount
    }

    // Use minOutputRaw (with 0.5% slippage) from the quote for on-chain order
    const outputAmount = quote.minOutputAmountRaw ?? rawOutputAmount;

    console.log(`[persistence] Preparing order: ${fromBtc.symbol} (${sourceChainId}) → ${toBtc.symbol} (${destChainId})`);
    console.log(`[persistence] Input: ${inputAmount}, Output: ${outputAmount}`);

    // Call prepareCrossChainOrder with `from` set so the contract sees msg.sender
    // as the swapper address. This makes the contract return the correct swapper
    // and a valid Permit2 nonce (next unused slot in the Permit2 bitmap).
    const callData = settlement.interface.encodeFunctionData("prepareCrossChainOrder", [
      fromBtc.address,
      inputAmount,
      toBtc.address,
      outputAmount,
      swapperAddress,
      destChainId,
      initiateDeadline,
      fillDeadline,
    ]);
    const rawResult = await provider.call({
      to: SETTLEMENT_CONTRACT,
      data: callData,
      from: swapperAddress,
    });
    const orderResult = settlement.interface.decodeFunctionResult("prepareCrossChainOrder", rawResult);
    // orderResult[0] is the tuple: (settlementContract, swapper, nonce, originChainId, initiateDeadline, fillDeadline, orderData)
    const contractOrder = orderResult[0];

    const order = {
      settlementContract: contractOrder.settlementContract as string,
      swapper: contractOrder.swapper as string,
      nonce: BigInt(contractOrder.nonce),
      originChainId: Number(contractOrder.originChainId),
      initiateDeadline: Number(contractOrder.initiateDeadline),
      fillDeadline: Number(contractOrder.fillDeadline),
      orderData: contractOrder.orderData as string,
    };
    console.log(`[persistence] Contract returned nonce: ${order.nonce}, swapper: ${order.swapper}`);

    // Build EIP-712 typed data for Permit2 witness signing
    const eip712Domain = {
      ...PERMIT2_DOMAIN,
      chainId: sourceChainId,
    };

    const eip712Value = {
      permitted: {
        token: fromBtc.address,
        amount: inputAmount,
      },
      spender: SETTLEMENT_CONTRACT,
      nonce: order.nonce,
      deadline: BigInt(initiateDeadline),
      witness: {
        settlementContract: order.settlementContract,
        swapper: order.swapper,
        nonce: order.nonce,
        originChainId: order.originChainId,
        initiateDeadline: order.initiateDeadline,
        fillDeadline: order.fillDeadline,
        orderData: order.orderData,
      },
    };

    // Build approval tx for Permit2
    const erc20Iface = new ethers.Interface(ERC20_ABI);
    const approvalData = erc20Iface.encodeFunctionData("approve", [
      PERMIT2_ADDRESS,
      inputAmount,
    ]);

    return {
      order,
      eip712Domain,
      eip712Types: PERMIT2_WITNESS_TYPES,
      eip712Value,
      inputToken: fromBtc.address,
      inputAmount,
      approvalTx: {
        to: fromBtc.address,
        data: approvalData,
        value: "0x0",
        chainId: sourceChainId,
      },
    };
  }

  /**
   * Build transaction data for the MCP flow (no server-side signing).
   * Calls prepareOrder() via on-chain view to get the EIP-712 typed data
   * and Permit2 approval tx that the agent/wallet must sign externally.
   *
   * Use signAndExecute() for flows where a signer (private key) is available.
   */
  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const data = quote.quoteData as any;
    const fromAddress = data.fromAddress;
    if (!fromAddress) {
      throw new Error(
        "fromAddress not available in Persistence quote. Re-quote with a fromAddress set."
      );
    }

    const prepared = await this.prepareOrder(quote, fromAddress);
    const sourceChainId = data.sourceChainId ?? 8453;
    const orderId = data.id ?? `pending-${Date.now()}`;

    // Serialize bigint values in EIP-712 typed data to strings for JSON
    const serializeBigInts = (obj: unknown): unknown => {
      if (typeof obj === "bigint") return obj.toString();
      if (Array.isArray(obj)) return obj.map(serializeBigInts);
      if (obj !== null && typeof obj === "object") {
        return Object.fromEntries(
          Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, serializeBigInts(v)])
        );
      }
      return obj;
    };

    return {
      // The on-chain initiate() call targets the settlement contract,
      // but execution requires the EIP-712 signature first — return placeholders.
      to: SETTLEMENT_CONTRACT,
      data: "0x",
      value: "0x0",
      chainId: sourceChainId,
      provider: "persistence",
      trackingId: `persistence:${orderId}`,
      approvalTx: prepared.approvalTx,
      eip712: {
        domain: serializeBigInts(prepared.eip712Domain) as Record<string, unknown>,
        types: prepared.eip712Types as unknown as Record<string, unknown>,
        value: serializeBigInts(prepared.eip712Value) as Record<string, unknown>,
        description:
          "Permit2 CrossChainOrder — sign this EIP-712 message with your wallet to authorize the " +
          "Persistence Interop bridge. After signing, call the settlement contract's initiate() " +
          "with the order struct and your signature.",
      },
    };
  }

  /**
   * Full sign-and-execute flow for when a signer (private key) is available.
   * This is used by test scripts and the ACP listener.
   *
   * Returns the source chain tx hash and order ID for tracking.
   */
  async signAndExecute(
    quote: BridgeQuote,
    signer: ethers.Wallet,
  ): Promise<{ txHash: string; orderId: string; trackingId: string }> {
    const data = quote.quoteData as any;
    const sourceChainId = data.sourceChainId ?? data.chainId ?? 8453;
    // Ensure signer is connected to the right chain
    const provider = await getProvider(sourceChainId);
    const connectedSigner = signer.connect(provider);
    const swapperAddress = await connectedSigner.getAddress();

    // Step 1: Prepare the order
    console.log("[persistence] Step 1: Preparing cross-chain order...");
    let prepared = await this.prepareOrder(quote, swapperAddress);

    // Step 2: Check and set Permit2 allowance
    console.log("[persistence] Step 2: Checking Permit2 allowance...");
    const erc20 = new ethers.Contract(prepared.inputToken, ERC20_ABI, connectedSigner);
    const currentAllowance = await erc20.allowance(swapperAddress, PERMIT2_ADDRESS);
    if (currentAllowance < BigInt(prepared.inputAmount)) {
      console.log("[persistence] Approving Permit2...");
      const approveTx = await erc20.approve(PERMIT2_ADDRESS, prepared.inputAmount);
      console.log(`[persistence] Approval tx: ${approveTx.hash}`);
      await approveTx.wait();
      // Brief delay after approval to let RPC nodes sync the new allowance.
      // Without this, estimateGas for initiate() can hit a node that hasn't seen the approval yet,
      // causing a spurious TRANSFER_FROM_FAILED error.
      console.log("[persistence] Permit2 approved. Waiting 2s for RPC propagation...");
      await new Promise(r => setTimeout(r, 2_000));
    } else {
      console.log("[persistence] Permit2 already has sufficient allowance.");
    }

    // Step 3: Sign EIP-712 typed data
    console.log("[persistence] Step 3: Signing EIP-712 typed data...");
    let signature = await connectedSigner.signTypedData(
      prepared.eip712Domain,
      prepared.eip712Types,
      prepared.eip712Value,
    );
    console.log("[persistence] Signature obtained.");

    // Step 4: Initiate on-chain (with nonce-collision retry)
    console.log("[persistence] Step 4: Initiating on-chain...");
    const settlement = new ethers.Contract(SETTLEMENT_CONTRACT, SETTLEMENT_ABI, connectedSigner);
    const fillerData = ethers.zeroPadValue("0x", 32);

    let orderTuple: any[] = [
      prepared.order.settlementContract,
      prepared.order.swapper,
      prepared.order.nonce,
      prepared.order.originChainId,
      prepared.order.initiateDeadline,
      prepared.order.fillDeadline,
      prepared.order.orderData,
    ];

    let initiateTx!: ethers.ContractTransactionResponse;
    let receipt: ethers.ContractTransactionReceipt | null;
    const MAX_NONCE_RETRIES = 2;
    let lastInitiateError: unknown = null;

    for (let attempt = 0; attempt <= MAX_NONCE_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          // Re-prepare with fresh nonce from the contract
          console.log(`[persistence] Retry ${attempt}/${MAX_NONCE_RETRIES}: preparing fresh order with new nonce...`);
          const freshPrepared = await this.prepareOrder(quote, swapperAddress);
          prepared = freshPrepared;

          // Re-sign with fresh nonce
          const freshSignature = await connectedSigner.signTypedData(
            freshPrepared.eip712Domain,
            freshPrepared.eip712Types,
            freshPrepared.eip712Value,
          );
          signature = freshSignature;

          // Rebuild order tuple
          orderTuple[0] = freshPrepared.order.settlementContract;
          orderTuple[1] = freshPrepared.order.swapper;
          orderTuple[2] = freshPrepared.order.nonce;
          orderTuple[3] = freshPrepared.order.originChainId;
          orderTuple[4] = freshPrepared.order.initiateDeadline;
          orderTuple[5] = freshPrepared.order.fillDeadline;
          orderTuple[6] = freshPrepared.order.orderData;
          console.log(`[persistence] Fresh nonce: ${freshPrepared.order.nonce}`);
        }

        initiateTx = await settlement.initiate(orderTuple, signature, fillerData);
        console.log(`[persistence] Initiate tx: ${initiateTx.hash}`);
        receipt = await initiateTx.wait();
        if (receipt && receipt.status === 0) {
          throw new Error(`Initiate transaction reverted on-chain (block ${receipt.blockNumber})`);
        }
        console.log(`[persistence] Confirmed in block ${receipt?.blockNumber}`);
        lastInitiateError = null;
        break; // Success — exit retry loop
      } catch (initiateError) {
        lastInitiateError = initiateError;
        const errMsg = (initiateError as Error).message ?? "";

        // Distinguish nonce errors (retryable) from transfer/balance errors (not retryable)
        const isTransferError = errMsg.includes("TRANSFER_FROM_FAILED") ||
          errMsg.includes("TRANSFER_FAILED") ||
          errMsg.includes("insufficient balance") ||
          errMsg.includes("ERC20: transfer amount exceeds balance");

        const isNonceError = !isTransferError && (
          errMsg.includes("NONCE_ALREADY_USED") ||
          errMsg.includes("InvalidNonce") ||
          errMsg.includes("nonce too low") ||
          errMsg.includes("nonce has already been used")
        );

        if (isTransferError && attempt < MAX_NONCE_RETRIES) {
          // Approval may not have propagated to all RPC nodes yet (race condition).
          // Wait a few seconds for sync, then retry with a fresh nonce/order.
          console.warn(
            `[persistence] initiate() got transfer error — waiting 3s for approval propagation (attempt ${attempt + 1}/${MAX_NONCE_RETRIES + 1})...`
          );
          await new Promise(r => setTimeout(r, 3_000));
          continue;
        } else if (isTransferError) {
          // All retries exhausted — this is a genuine balance/allowance issue
          console.warn(
            `[persistence] initiate() failed with transfer/balance error after ${attempt + 1} attempts: ${errMsg.slice(0, 200)}`
          );
        } else if (isNonceError && attempt < MAX_NONCE_RETRIES) {
          console.warn(`[persistence] initiate() failed with nonce error (attempt ${attempt + 1}), will retry with fresh nonce`);
          continue;
        }

        // Final failure — revoke approval and throw
        console.warn(
          `[persistence] initiate() failed after ${attempt + 1} attempt(s). Revoking Permit2 ERC20 approval.`
        );
        try {
          const revokeTx = await erc20.approve(PERMIT2_ADDRESS, 0);
          await revokeTx.wait();
          console.log("[persistence] Permit2 approval revoked (set to 0).");
        } catch (revokeError) {
          console.error(`[persistence] Failed to revoke Permit2 approval: ${(revokeError as Error).message}`);
        }
        throw initiateError;
      }
    }

    if (lastInitiateError) throw lastInitiateError;

    // Step 5: Submit to backend
    console.log("[persistence] Step 5: Submitting to backend...");
    const orderId = data.id ?? `order-${Date.now()}`;
    // Compute orderHash: keccak256 of the ABI-encoded order struct (hoisted for retry access)
    const orderHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint32", "uint32", "uint32", "bytes"],
        [
          prepared.order.settlementContract,
          prepared.order.swapper,
          prepared.order.nonce,
          prepared.order.originChainId,
          prepared.order.initiateDeadline,
          prepared.order.fillDeadline,
          prepared.order.orderData,
        ]
      )
    );
    console.log(`[persistence] Order hash: ${orderHash}`);

    try {
      await fetchJson(`${BASE_URL}/orders/submit-with-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementContract: prepared.order.settlementContract,
          swapper: swapperAddress,
          nonce: Number(prepared.order.nonce),
          originChainId: sourceChainId,
          initiateDeadline: Number(prepared.order.initiateDeadline),
          fillDeadline: Number(prepared.order.fillDeadline),
          orderData: prepared.order.orderData,
          signature,
          orderHash,
          sourceChainTxHash: initiateTx.hash,
        }),
      });
      console.log("[persistence] Order submitted to backend.");
    } catch (err) {
      console.warn(`[persistence] Backend submission failed, retrying once: ${(err as Error).message}`);
      try {
        await new Promise(r => setTimeout(r, 2000));
        await fetchJson(`${BASE_URL}/orders/submit-with-tx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settlementContract: prepared.order.settlementContract,
            swapper: swapperAddress,
            nonce: Number(prepared.order.nonce),
            originChainId: sourceChainId,
            initiateDeadline: Number(prepared.order.initiateDeadline),
            fillDeadline: Number(prepared.order.fillDeadline),
            orderData: prepared.order.orderData,
            signature,
            orderHash,
            sourceChainTxHash: initiateTx.hash,
          }),
        });
        console.log("[persistence] Order submitted to backend (retry succeeded).");
      } catch (retryErr) {
        console.warn(`[persistence] Backend submission retry also failed (non-fatal): ${(retryErr as Error).message}`);
      }
    }

    return {
      txHash: initiateTx.hash,
      orderId,
      trackingId: `persistence:${orderId}`,
    };
  }

  async getStatus(
    trackingId: string,
    meta?: Record<string, string>
  ): Promise<BridgeStatus> {
    try {
      const orderId = meta?.orderId ?? trackingId.replace("persistence:", "");

      // Use /orders/{orderId}/status for order lifecycle status
      const data = await fetchJson(
        `${BASE_URL}/orders/${orderId}/status`
      );

      // Map API statuses to BridgeStatus states
      const stateMap: Record<string, BridgeStatus["state"]> = {
        CREATED: "pending",
        ACCEPTED: "pending",
        SUBMITTED_SOURCE: "in_progress",
        USER_SUBMITTED_SOURCE: "in_progress",
        PENDING_CONFIRMATION: "in_progress",
        FULFILLED: "completed",
        EXPIRED: "failed",
        UNFULFILLED: "failed",
        VERIFICATION_FAILED: "failed",
      };

      return {
        state: stateMap[data.status] ?? "in_progress",
        humanReadable: `Persistence Interop: ${data.status ?? "unknown"}`,
        sourceTxHash: data.sourceChainTxHash,
        destTxHash: data.destinationChainTxHash,
        provider: "persistence",
        elapsed: 0,
      };
    } catch (err) {
      return {
        state: "unknown",
        humanReadable: `Status check failed: ${sanitizeError(err as Error)}`,
        provider: "persistence",
        elapsed: 0,
      };
    }
  }

  async getSupportedChains(): Promise<ChainInfo[]> {
    return SUPPORTED_CHAINS.map((c) => ({
      ...c,
      providers: ["persistence"],
    }));
  }
}
