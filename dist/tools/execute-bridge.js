import { z } from "zod";
import { ethers } from "ethers";
import { simulateTransaction } from "../utils/tx-simulator.js";
import { getChainName, isSolanaChain } from "../utils/chains.js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { getKey } from "./wallet.js";
import { getProvider } from "../utils/gas-estimator.js";
// H-3: Quote execution locking — prevent double-execution
const executingQuotes = new Set();
/** Default timeout for buildTransaction API calls (ms) */
const BUILD_TX_TIMEOUT_MS = Number(process.env.BRIDGEKITTY_TX_TIMEOUT_MS) || 30_000;
/**
 * Race a promise against a timeout. Returns a clear error on timeout instead of hanging.
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}
/** Best-effort chain explorer URL for a tx hash. */
function getExplorerTxUrl(chainIdOrQuoteData, txHash) {
    const chainId = typeof chainIdOrQuoteData === "number"
        ? chainIdOrQuoteData
        : (chainIdOrQuoteData?.sourceChainId ?? chainIdOrQuoteData?.chainId ?? 0);
    const explorers = {
        1: "https://etherscan.io/tx/",
        10: "https://optimistic.etherscan.io/tx/",
        56: "https://bscscan.com/tx/",
        137: "https://polygonscan.com/tx/",
        8453: "https://basescan.org/tx/",
        42161: "https://arbiscan.io/tx/",
        43114: "https://snowtrace.io/tx/",
        250: "https://ftmscan.com/tx/",
        324: "https://explorer.zksync.io/tx/",
        59144: "https://lineascan.build/tx/",
        534352: "https://scrollscan.com/tx/",
        81457: "https://blastscan.io/tx/",
    };
    const base = explorers[chainId];
    return base ? `${base}${txHash}` : `chainId:${chainId}/tx/${txHash}`;
}
export function registerExecuteBridge(server, engine) {
    server.tool("bridge_execute", "Get the unsigned transaction data to execute a cross-chain bridge transfer. " +
        "Supports all providers: LI.FI, Squid Router, deBridge, Across, Relay, Persistence Interop. " +
        "By default returns unsigned transaction(s) for the agent/user to sign and send. " +
        "Set sign_and_send=true to sign and broadcast using the locally-stored wallet key (requires wallet_setup). " +
        "Preconditions: Call bridge_get_quote first and pass the quoteId. Ensure sufficient gas on source chain. " +
        "If an approval is needed (unsigned mode), send the approvalTransaction first, then the main transaction. " +
        "After execution, use bridge_status with the returned trackingId to monitor progress.", {
        quoteId: z
            .string()
            .describe("Quote ID from bridge_get_quote result"),
        slippage: z
            .number()
            .default(0.005)
            .describe("Max slippage tolerance (0.005 = 0.5%). Applied by backends during quoting; reserved for future per-execution override."),
        sign_and_send: z
            .boolean()
            .default(false)
            .describe("If true, sign and broadcast the transaction server-side using the wallet key from wallet_setup. Supports EVM chains and Persistence Interop. Solana falls back to unsigned."),
    }, async (params) => {
        let quote = engine.getCachedQuote(params.quoteId);
        // Auto-refresh expired quotes using the original parameters
        if (!quote) {
            const cached = engine.getCachedQuoteWithExpiry(params.quoteId);
            if (cached?.expired && cached.quote.quoteData) {
                try {
                    const qd = cached.quote.quoteData;
                    const p = qd?.params;
                    if (p) {
                        console.warn("[bridge_execute] Quote expired, auto-refreshing...");
                        const freshQuotes = await engine.getQuotes({
                            fromChainId: p.srcChainId,
                            toChainId: p.dstChainId,
                            fromTokenAddress: p.srcChainTokenIn,
                            toTokenAddress: p.dstChainTokenOut,
                            amountRaw: p.srcChainTokenInAmount,
                            fromAddress: p.fromAddress,
                            toAddress: p.toAddress,
                            providers: [cached.quote.backendName],
                            preference: "cheapest",
                        });
                        if (freshQuotes.length > 0) {
                            quote = freshQuotes[0];
                        }
                    }
                }
                catch (err) {
                    console.error("[bridge_execute] Auto-refresh failed:", err.message);
                }
            }
        }
        if (!quote) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Quote expired or not found. Please call bridge_get_quote again to get a fresh quote.",
                    },
                ],
            };
        }
        const backend = engine.getBackend(quote.backendName);
        if (!backend) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Backend '${quote.backendName}' not available. Known backends: ${engine.getAllBackends().map((b) => b.name).join(", ")}`,
                    },
                ],
            };
        }
        // H-3: Prevent double-execution of the same quote
        if (executingQuotes.has(params.quoteId)) {
            return {
                content: [
                    {
                        type: "text",
                        text: "This quote is already being executed. Please wait for the current execution to complete.",
                    },
                ],
                isError: true,
            };
        }
        executingQuotes.add(params.quoteId);
        try {
            // MEDIUM-004: Pre-build expiry check — reject quotes that would expire during building
            const BUILD_TIMEOUT_MS = 15_000;
            if (quote.expiresAt && quote.expiresAt <= Date.now() + BUILD_TIMEOUT_MS) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Quote is about to expire (or already expired) and may not survive the build step. Please call bridge_get_quote again to get a fresh quote.",
                        },
                    ],
                };
            }
            // ── sign_and_send flow ──────────────────────────────────────────
            if (params.sign_and_send) {
                const privateKey = getKey("privateKey");
                if (!privateKey) {
                    return {
                        content: [{
                                type: "text",
                                text: "No wallet key found. Run wallet_setup first to generate or import a wallet before using sign_and_send.",
                            }],
                        isError: true,
                    };
                }
                // Persistence Interop (EIP-712): use signAndExecute directly
                if (quote.backendName === "persistence") {
                    const persistenceBackend = backend;
                    const signer = new ethers.Wallet(privateKey);
                    const result = await persistenceBackend.signAndExecute(quote, signer);
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({
                                    status: "sent",
                                    provider: quote.provider,
                                    txHash: result.txHash,
                                    orderId: result.orderId,
                                    trackingId: result.trackingId,
                                    explorerUrl: getExplorerTxUrl(quote.quoteData, result.txHash),
                                    instructions: "Transaction signed and sent. Use bridge_status with the trackingId to monitor progress.",
                                }, null, 2),
                            }],
                    };
                }
                // Solana: not yet supported for sign_and_send — fall through to unsigned flow
                if (isSolanaChain(quote.quoteData && typeof quote.quoteData === "object" && "srcChainId" in quote.quoteData ? quote.quoteData.srcChainId : 0)) {
                    // Fall through to the unsigned flow below with a note
                    const txRequest = await withTimeout(backend.buildTransaction(quote), BUILD_TX_TIMEOUT_MS, `buildTransaction (${backend.name})`);
                    if (txRequest.solanaTransaction) {
                        const response = {
                            provider: txRequest.provider,
                            trackingId: txRequest.trackingId,
                            slippage: params.slippage,
                            transaction: {
                                type: "solana",
                                serializedTx: txRequest.solanaTransaction.serializedTx,
                                chainId: txRequest.chainId,
                            },
                            note: "sign_and_send is not yet supported for Solana transactions. Returning unsigned transaction instead.",
                            instructions: "This is a Solana transaction. Sign and send it using a Solana wallet. " +
                                "The serializedTx is hex-encoded (0x-prefixed) — decode with Buffer.from(data.slice(2), 'hex'), " +
                                "then deserialize as a VersionedTransaction. IMPORTANT: replace the recentBlockhash with a " +
                                "fresh one from getLatestBlockhash() before signing, as the embedded blockhash may be stale. " +
                                "After sending, use bridge_status with the trackingId to monitor progress.",
                        };
                        return {
                            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
                        };
                    }
                }
                // Standard EVM flow: sign & send approval + main tx
                const txRequest = await withTimeout(backend.buildTransaction(quote), BUILD_TX_TIMEOUT_MS, `buildTransaction (${backend.name})`);
                const signer = new ethers.Wallet(privateKey);
                const provider = await getProvider(txRequest.chainId);
                const connectedSigner = signer.connect(provider);
                // Handle approval tx if present
                if (txRequest.approvalTx) {
                    const approvalResponse = await connectedSigner.sendTransaction({
                        to: txRequest.approvalTx.to,
                        data: txRequest.approvalTx.data,
                        value: txRequest.approvalTx.value,
                    });
                    await approvalResponse.wait();
                    // If backend needs post-approval rebuild, re-fetch the main tx
                    if (txRequest.needsPostApprovalBuild) {
                        const freshTx = await withTimeout(backend.buildTransaction(quote), BUILD_TX_TIMEOUT_MS, `buildTransaction post-approval (${backend.name})`);
                        txRequest.to = freshTx.to;
                        txRequest.data = freshTx.data;
                        txRequest.value = freshTx.value;
                        txRequest.gasLimit = freshTx.gasLimit;
                    }
                }
                // Simulate before sending
                const sim = await simulateTransaction(txRequest.chainId, {
                    to: txRequest.to,
                    data: txRequest.data,
                    value: txRequest.value,
                    from: connectedSigner.address,
                });
                if (!sim.success) {
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({
                                    error: "Transaction simulation failed",
                                    message: sim.error,
                                    advice: "The transaction would likely revert on-chain. Please get a fresh quote and try again.",
                                    provider: txRequest.provider,
                                }, null, 2),
                            }],
                        isError: true,
                    };
                }
                // Send the main transaction
                const txResponse = await connectedSigner.sendTransaction({
                    to: txRequest.to,
                    data: txRequest.data,
                    value: txRequest.value,
                    ...(txRequest.gasLimit ? { gasLimit: txRequest.gasLimit } : {}),
                    ...(sim.estimatedGas ? { gasLimit: sim.estimatedGas } : {}),
                });
                const receipt = await txResponse.wait();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: "sent",
                                provider: txRequest.provider,
                                txHash: txResponse.hash,
                                blockNumber: receipt?.blockNumber,
                                trackingId: txRequest.trackingId,
                                explorerUrl: getExplorerTxUrl(txRequest.chainId, txResponse.hash),
                                instructions: "Transaction signed and sent. Use bridge_status with the trackingId to monitor progress.",
                            }, null, 2),
                        }],
                };
            }
            // ── Unsigned flow (default) ─────────────────────────────────────
            const txRequest = await withTimeout(backend.buildTransaction(quote), BUILD_TX_TIMEOUT_MS, `buildTransaction (${backend.name})`);
            // EIP-712 flow (e.g. Persistence Interop): skip on-chain simulation,
            // return the typed data for the agent to sign externally.
            if (txRequest.eip712) {
                const response = {
                    provider: txRequest.provider,
                    trackingId: txRequest.trackingId,
                    slippage: params.slippage,
                    signingRequest: {
                        type: "eip712",
                        domain: txRequest.eip712.domain,
                        types: txRequest.eip712.types,
                        value: txRequest.eip712.value,
                        description: txRequest.eip712.description,
                    },
                    instructions: "Three steps required: " +
                        "(1) Send the approvalTransaction to approve the token for Permit2 (exact amount, not unlimited). " +
                        "(2) Sign the EIP-712 message in signingRequest with your wallet (eth_signTypedData_v4). " +
                        "(3) Call the settlement contract's initiate() with the order struct and your signature. " +
                        "Alternatively, use the xprt_farm_prepare / xprt_farm_start tools for automated server-side execution, " +
                        "or pass sign_and_send=true to handle all steps automatically.",
                };
                if (txRequest.approvalTx) {
                    response.approvalTransaction = {
                        to: txRequest.approvalTx.to,
                        data: txRequest.approvalTx.data,
                        value: txRequest.approvalTx.value,
                        chainId: txRequest.approvalTx.chainId,
                    };
                    response.approvalNote =
                        "Approval is for the EXACT bridge amount only — not unlimited. " +
                            "A new approval is needed for each bridge transaction.";
                }
                return {
                    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
                };
            }
            // Solana transaction flow: return serialized tx for signing
            if (txRequest.solanaTransaction) {
                const response = {
                    provider: txRequest.provider,
                    trackingId: txRequest.trackingId,
                    slippage: params.slippage,
                    transaction: {
                        type: "solana",
                        serializedTx: txRequest.solanaTransaction.serializedTx,
                        chainId: txRequest.chainId,
                    },
                    instructions: "This is a Solana transaction. Sign and send it using a Solana wallet. " +
                        "The serializedTx is hex-encoded (0x-prefixed) — decode with Buffer.from(data.slice(2), 'hex'), " +
                        "then deserialize as a VersionedTransaction. IMPORTANT: replace the recentBlockhash with a " +
                        "fresh one from getLatestBlockhash() before signing, as the embedded blockhash may be stale. " +
                        "After sending, use bridge_status with the trackingId to monitor progress.",
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
                };
            }
            // Simulate the main transaction to verify it won't revert.
            // Skip simulation when an approval tx is pending — the main tx would
            // naturally revert with "transfer amount exceeds allowance" until the
            // user has sent the approval on-chain.
            const warnings = [];
            if (!txRequest.approvalTx) {
                const simulation = await simulateTransaction(txRequest.chainId, {
                    to: txRequest.to,
                    data: txRequest.data,
                    value: txRequest.value,
                });
                if (!simulation.success) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    error: "Transaction simulation failed",
                                    message: simulation.error,
                                    advice: "The transaction would likely revert on-chain. Please get a fresh quote and try again.",
                                    provider: txRequest.provider,
                                }, null, 2),
                            },
                        ],
                        isError: true,
                    };
                }
                if (simulation.warning) {
                    warnings.push(simulation.warning);
                }
                if (simulation.estimatedGas) {
                    txRequest.gasLimit = txRequest.gasLimit ?? simulation.estimatedGas;
                }
            }
            const response = {
                provider: txRequest.provider,
                trackingId: txRequest.trackingId,
                slippage: params.slippage,
                transaction: {
                    to: txRequest.to,
                    data: txRequest.data,
                    value: txRequest.value,
                    chainId: txRequest.chainId,
                    ...(txRequest.gasLimit ? { gasLimit: txRequest.gasLimit } : {}),
                },
                instructions: "Sign and send this transaction to initiate the bridge transfer.",
            };
            if (txRequest.approvalTx) {
                response.approvalTransaction = {
                    to: txRequest.approvalTx.to,
                    data: txRequest.approvalTx.data,
                    value: txRequest.approvalTx.value,
                    chainId: txRequest.approvalTx.chainId,
                };
                if (txRequest.needsPostApprovalBuild) {
                    response.instructions =
                        "Two-phase execution needed: (1) Send the approvalTransaction first. (2) AFTER approval confirms, " +
                            "call bridge_execute again with the same quoteId — the bridge tx will be re-fetched with the correct nonce.";
                    response.needsPostApprovalBuild = true;
                }
                else {
                    response.instructions =
                        "Two transactions needed: (1) Send the approvalTransaction first to approve token spending (exact amount, not unlimited). (2) Then send the main transaction to initiate the bridge.";
                }
                response.approvalNote =
                    "The approval is for the EXACT bridge amount only — not an unlimited approval. " +
                        "This is safer but means you'll need a new approval for each bridge transaction.";
            }
            // Warn about native token requirements (e.g. deBridge protocol fees)
            if (txRequest.value && txRequest.value !== "0x0" && txRequest.value !== "0x00") {
                const valueBigInt = BigInt(txRequest.value);
                if (valueBigInt > 0n) {
                    const ethAmount = Number(valueBigInt) / 1e18;
                    const chainName = getChainName(txRequest.chainId) ?? `chain ${txRequest.chainId}`;
                    const nativeSymbol = [56].includes(txRequest.chainId) ? "BNB"
                        : [137].includes(txRequest.chainId) ? "MATIC"
                            : [43114].includes(txRequest.chainId) ? "AVAX"
                                : "ETH";
                    warnings.push(`⚠️ This transaction requires ${ethAmount.toFixed(6)} ${nativeSymbol} for protocol fees in addition to the bridge amount. Ensure your wallet on ${chainName} has sufficient ${nativeSymbol} balance.`);
                }
            }
            if (warnings.length > 0) {
                response.warnings = warnings;
            }
            return {
                content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
            };
        }
        catch (err) {
            // Release lock on failure so the user can retry
            executingQuotes.delete(params.quoteId);
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to build transaction: ${sanitizeError(err)}`,
                    },
                ],
            };
        }
        // H-3: Lock stays held on success — quote cannot be re-executed.
        // Lock is only released on error (above) to allow retry.
    });
}
