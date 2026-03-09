import { formatTokenAmount } from "../utils/tokens.js";
import { getBackendChainId, getAllChains, isSolanaChain } from "../utils/chains.js";
import { buildApproveData, isNativeToken } from "../utils/evm.js";
import { estimateGasCostUsd, getGasUnits } from "../utils/gas-estimator.js";
import { sanitizeError } from "../utils/sanitize-error.js";
const BASE_URL = "https://api.dln.trade/v1.0";
const TIMEOUT_MS = 15_000;
async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`deBridge ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
// buildApproveData imported from ../utils/evm.js
export class DeBridgeBackend {
    name = "debridge";
    affiliateFeePercent;
    affiliateFeeRecipient;
    constructor(affiliateFeePercent, affiliateFeeRecipient) {
        this.affiliateFeePercent = affiliateFeePercent;
        this.affiliateFeeRecipient = affiliateFeeRecipient;
    }
    async getQuote(params) {
        try {
            const url = new URL(`${BASE_URL}/dln/order/quote`);
            const srcChainId = getBackendChainId("debridge", params.fromChainId);
            const dstChainId = getBackendChainId("debridge", params.toChainId);
            url.searchParams.set("srcChainId", String(srcChainId));
            // deBridge uses 0x000...0 for native EVM tokens (not 0xEeee...); convert.
            const srcToken = isNativeToken(params.fromTokenAddress)
                ? "0x0000000000000000000000000000000000000000"
                : params.fromTokenAddress;
            url.searchParams.set("srcChainTokenIn", srcToken);
            url.searchParams.set("srcChainTokenInAmount", params.amountRaw);
            url.searchParams.set("dstChainId", String(dstChainId));
            // deBridge uses native SOL address (system program) instead of wrapped SOL mint.
            // Using the native address ensures the solver delivers actual SOL, not wSOL.
            const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
            const NATIVE_SOL_ADDRESS = "11111111111111111111111111111111";
            let dstToken = params.toTokenAddress;
            if (isSolanaChain(params.toChainId) && params.toTokenAddress === WRAPPED_SOL_MINT) {
                dstToken = NATIVE_SOL_ADDRESS;
            }
            else if (!isSolanaChain(params.toChainId) && isNativeToken(params.toTokenAddress)) {
                // deBridge uses 0x000...0 for native EVM tokens on destination too
                dstToken = "0x0000000000000000000000000000000000000000";
            }
            url.searchParams.set("dstChainTokenOut", dstToken);
            url.searchParams.set("prependOperatingExpenses", "true");
            if (this.affiliateFeePercent && this.affiliateFeeRecipient) {
                url.searchParams.set("affiliateFeePercent", this.affiliateFeePercent);
                url.searchParams.set("affiliateFeeRecipient", this.affiliateFeeRecipient);
            }
            let data;
            try {
                data = await fetchJson(url.toString());
            }
            catch (err) {
                // If affiliate fee params caused the error, retry without them
                if (this.affiliateFeePercent && this.affiliateFeeRecipient) {
                    console.warn("[debridge] quote failed with affiliate fee, retrying without fee:", err.message);
                    url.searchParams.delete("affiliateFeePercent");
                    url.searchParams.delete("affiliateFeeRecipient");
                    data = await fetchJson(url.toString());
                }
                else {
                    throw err;
                }
            }
            if (!data.estimation)
                return null;
            const dstAmount = data.estimation.dstChainTokenOut?.amount ?? "0";
            const dstDecimals = data.estimation.dstChainTokenOut?.decimals ?? 18;
            const srcTokenSymbol = data.estimation.srcChainTokenIn?.symbol ?? "?";
            const dstTokenSymbol = data.estimation.dstChainTokenOut?.symbol ?? "?";
            // Calculate fee from operating expenses (with safe parsing)
            let totalFeeUsd = 0;
            const costsDetails = data.estimation.costsDetails;
            if (Array.isArray(costsDetails)) {
                for (const c of costsDetails) {
                    const usd = Number(c?.payload?.feeApproximateUsdValue ?? 0);
                    if (!isNaN(usd))
                        totalFeeUsd += usd;
                }
            }
            // Estimate source chain gas cost (chain-aware)
            const gasUnits = getGasUnits("debridge", params.fromChainId);
            const gasEstimate = await estimateGasCostUsd(params.fromChainId, gasUnits);
            const gasCostUsd = gasEstimate?.costUsd ?? null;
            // deBridge DLN is intent-based: the recommended amount is what the solver commits to deliver.
            // Use recommendedAmount if available (guaranteed), otherwise apply 0.5% slippage to estimated.
            const recommendedRaw = data.estimation.dstChainTokenOut?.recommendedAmount;
            let minOutputRaw;
            if (recommendedRaw) {
                minOutputRaw = recommendedRaw;
            }
            else {
                // Apply 0.5% slippage tolerance
                try {
                    const outputBig = BigInt(dstAmount);
                    minOutputRaw = (outputBig * 995n / 1000n).toString();
                }
                catch {
                    minOutputRaw = dstAmount;
                }
            }
            // Extract fixFee (flat protocol fee in native token, e.g. 0.001 ETH)
            // This is added to tx.value on top of the bridge amount — critical for balance checks
            const fixFee = data.fixFee ? String(data.fixFee) : "0";
            const operatingExpense = data.estimation.srcChainTokenIn?.approximateOperatingExpense ?? "0";
            // Total amount the user actually needs (input + operating expenses + fixFee for native)
            const totalSourceAmount = data.estimation.srcChainTokenIn?.amount ?? params.amountRaw;
            return {
                backendName: "debridge",
                provider: "deBridge (direct)",
                outputAmount: formatTokenAmount(dstAmount, dstDecimals),
                outputAmountRaw: dstAmount,
                minOutputAmount: formatTokenAmount(minOutputRaw, dstDecimals),
                minOutputAmountRaw: minOutputRaw,
                outputDecimals: dstDecimals,
                estimatedGasCostUsd: gasCostUsd,
                usingFallbackPrices: gasEstimate?.usingFallbackPrices,
                estimatedFeeUsd: gasCostUsd !== null ? totalFeeUsd + gasCostUsd : null,
                feeBreakdown: {
                    gasCostUsd,
                    protocolFeeUsd: totalFeeUsd,
                    integratorFeeUsd: 0,
                    integratorFeePercent: null,
                    totalFeeUsd: gasCostUsd !== null ? totalFeeUsd + gasCostUsd : null,
                    // deBridge-specific: flat fee in native token (e.g. 0.001 ETH on Base)
                    fixFeeNativeRaw: fixFee,
                    operatingExpenseRaw: operatingExpense,
                    totalSourceAmountRaw: totalSourceAmount,
                },
                estimatedTimeSeconds: data.estimation.estimatedFulfillmentDelay ?? 30,
                route: `${srcTokenSymbol} → deBridge DLN → ${dstTokenSymbol}`,
                quoteData: {
                    estimation: data.estimation,
                    order: data.order,
                    fixFee,
                    params: {
                        srcChainId: params.fromChainId,
                        dstChainId: params.toChainId,
                        srcChainTokenIn: params.fromTokenAddress,
                        dstChainTokenOut: dstToken,
                        srcChainTokenInAmount: params.amountRaw,
                        fromAddress: params.fromAddress,
                        toAddress: params.toAddress || params.fromAddress,
                    },
                },
                // deBridge DLN quotes: use estimation expiry if available, else conservative 30s
                expiresAt: data.estimation?.expiration
                    ? new Date(data.estimation.expiration).getTime()
                    : Date.now() + 60_000,
            };
        }
        catch (err) {
            console.error("[debridge] quote error:", err.message);
            return null;
        }
    }
    async buildTransaction(quote) {
        const qd = quote.quoteData;
        const p = qd.params;
        // Use create-tx endpoint to get the actual transaction
        // Apply backend-specific chain ID mapping (same as getQuote)
        const srcChainId = getBackendChainId("debridge", p.srcChainId);
        const dstChainId = getBackendChainId("debridge", p.dstChainId);
        const url = new URL(`${BASE_URL}/dln/order/create-tx`);
        url.searchParams.set("srcChainId", String(srcChainId));
        url.searchParams.set("srcChainTokenIn", p.srcChainTokenIn);
        url.searchParams.set("srcChainTokenInAmount", p.srcChainTokenInAmount);
        url.searchParams.set("dstChainId", String(dstChainId));
        url.searchParams.set("dstChainTokenOut", p.dstChainTokenOut);
        url.searchParams.set("dstChainTokenOutAmount", "auto");
        url.searchParams.set("srcChainOrderAuthorityAddress", p.fromAddress);
        url.searchParams.set("dstChainTokenOutRecipient", p.toAddress);
        // senderAddress is REQUIRED for the API to return tx.to/tx.data/tx.value
        url.searchParams.set("senderAddress", p.fromAddress);
        url.searchParams.set("srcChainRefundAddress", p.fromAddress);
        url.searchParams.set("dstChainOrderAuthorityAddress", p.toAddress);
        url.searchParams.set("prependOperatingExpenses", "true");
        if (this.affiliateFeePercent && this.affiliateFeeRecipient) {
            url.searchParams.set("affiliateFeePercent", this.affiliateFeePercent);
            url.searchParams.set("affiliateFeeRecipient", this.affiliateFeeRecipient);
        }
        let data;
        try {
            data = await fetchJson(url.toString());
        }
        catch (err) {
            if (this.affiliateFeePercent && this.affiliateFeeRecipient) {
                console.warn("[debridge] create-tx failed with affiliate fee, retrying without:", err.message);
                url.searchParams.delete("affiliateFeePercent");
                url.searchParams.delete("affiliateFeeRecipient");
                data = await fetchJson(url.toString());
            }
            else {
                throw err;
            }
        }
        const orderId = data.orderId ?? `${Date.now()}`;
        // Handle Solana source chains — deBridge returns serialized Solana transaction
        if (isSolanaChain(p.srcChainId)) {
            // For Solana, deBridge returns data.tx.data as a hex-encoded (0x-prefixed) serialized
            // VersionedTransaction. Caller must decode hex, replace recentBlockhash, sign, and send.
            const serializedTx = data.tx.data || data.tx.serializedTx;
            if (!serializedTx) {
                throw new Error("Invalid Solana transaction data in deBridge create-tx response. " +
                    "Expected serialized transaction in tx.data.");
            }
            return {
                // Use placeholder values for EVM-specific fields (not used for Solana)
                to: "solana",
                data: "0x",
                value: "0x0",
                chainId: p.srcChainId,
                provider: "debridge",
                trackingId: `debridge:${orderId}`,
                solanaTransaction: {
                    serializedTx,
                },
            };
        }
        // EVM source chain handling
        if (!data.tx || !data.tx.to || !data.tx.data) {
            throw new Error("Invalid or missing transaction data in deBridge create-tx response. " +
                "Ensure senderAddress is provided.");
        }
        const result = {
            to: data.tx.to,
            data: data.tx.data,
            value: data.tx.value ? `0x${BigInt(data.tx.value).toString(16)}` : "0x0",
            chainId: p.srcChainId,
            provider: "debridge",
            trackingId: `debridge:${orderId}`,
        };
        // Check if ERC20 approval is needed (non-native token)
        // deBridge API doesn't return allowanceTarget — use tx.to (the DlnSource contract)
        // as the spender for the ERC20 approval.
        // When prependOperatingExpenses=true, the contract pulls MORE than the user's input amount
        // (input + operating expenses). The estimation.srcChainTokenIn.amount includes expenses,
        // but the exact tx-encoded amount can differ slightly due to gas price fluctuation
        // between the estimation and tx encoding. Add a 5% buffer to prevent allowance failures.
        const approvalSpender = data.tx.allowanceTarget ?? data.tx.to;
        if (approvalSpender && !isNativeToken(p.srcChainTokenIn)) {
            const estimatedAmount = data.estimation?.srcChainTokenIn?.amount ?? p.srcChainTokenInAmount;
            // Buffer the approval by 5% to account for operating expense fluctuation.
            // This is still a per-transaction approval (not unlimited) — safe and scoped.
            const approvalAmount = (BigInt(estimatedAmount) * 105n / 100n).toString();
            result.approvalTx = {
                to: p.srcChainTokenIn,
                data: buildApproveData(approvalSpender, approvalAmount),
                value: "0x0",
                chainId: p.srcChainId,
            };
            // deBridge's create-tx embeds the nonce from when it was called.
            // After approval is sent, the nonce becomes stale.
            // Caller must re-fetch the bridge tx after approval confirms.
            result.needsPostApprovalBuild = true;
        }
        return result;
    }
    async getStatus(trackingId, meta) {
        try {
            const orderId = trackingId.replace("debridge:", "");
            const url = new URL(`${BASE_URL}/dln/order/${orderId}/status`);
            const data = await fetchJson(url.toString());
            const stateMap = {
                None: "pending",
                Created: "pending",
                Fulfilled: "completed",
                SentUnlock: "completed",
                OrderCancelled: "failed",
                SentOrderCancel: "failed",
                ClaimedUnlock: "completed",
                ClaimedOrderCancel: "refunded",
            };
            return {
                state: stateMap[data.status] ?? "in_progress",
                humanReadable: `deBridge DLN order: ${data.status ?? "unknown"}`,
                sourceTxHash: meta?.txHash,
                destTxHash: data.fulfillTxHash,
                provider: "debridge",
                elapsed: 0,
            };
        }
        catch (err) {
            // Fallback: check on-chain tx receipt if we have a txHash
            if (meta?.txHash && meta?.fromChain) {
                try {
                    const { getProvider } = await import("../utils/gas-estimator.js");
                    const chainId = Number(meta.fromChain);
                    if (!isNaN(chainId) && !isSolanaChain(chainId)) {
                        const provider = await getProvider(chainId);
                        const receipt = await provider.getTransactionReceipt(meta.txHash);
                        if (receipt) {
                            const confirmed = receipt.status === 1;
                            return {
                                state: confirmed ? "pending" : "failed",
                                humanReadable: confirmed
                                    ? `Transaction confirmed on-chain (block ${receipt.blockNumber}). Bridge provider hasn't indexed the order yet — this is normal, check again in 1-2 minutes.`
                                    : `Transaction reverted on-chain (block ${receipt.blockNumber}). The bridge transaction failed.`,
                                sourceTxHash: meta.txHash,
                                provider: "debridge",
                                elapsed: 0,
                            };
                        }
                        else {
                            return {
                                state: "pending",
                                humanReadable: "Transaction submitted but not yet confirmed on-chain. Wait for block confirmation.",
                                sourceTxHash: meta.txHash,
                                provider: "debridge",
                                elapsed: 0,
                            };
                        }
                    }
                }
                catch {
                    // On-chain check failed too — fall through to unknown
                }
            }
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${sanitizeError(err)}. If you just submitted the transaction, wait 1-2 minutes for the bridge provider to index it.`,
                provider: "debridge",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        try {
            const allChains = getAllChains();
            // Name-to-canonical lookup (for chains where originalChainId is missing/wrong)
            const nameToCanonical = new Map(allChains.map((c) => [c.name.toLowerCase(), c]));
            const data = await fetchJson(`${BASE_URL}/supported-chains-info`);
            if (Array.isArray(data.chains)) {
                const seen = new Set();
                const result = [];
                for (const chain of data.chains) {
                    // deBridge: originalChainId = EVM canonical ID, chainId = deBridge internal ID
                    const rawId = chain.originalChainId ?? chain.chainId;
                    const chainName = chain.chainName ?? "";
                    // Match canonical entry by ID first, then by name (catches wrong/missing originalChainId)
                    const canonical = allChains.find((c) => c.id === rawId) ??
                        nameToCanonical.get(chainName.toLowerCase());
                    const id = canonical?.id ?? rawId;
                    // Deduplicate: skip if we already have this canonical chain
                    if (seen.has(id))
                        continue;
                    seen.add(id);
                    result.push({
                        id,
                        name: canonical?.name ?? chainName,
                        key: canonical?.key ?? chainName.toLowerCase().replace(/\s+/g, "-"),
                        providers: ["debridge"],
                    });
                }
                return result;
            }
        }
        catch {
            // Fallback to hardcoded chains if API fails
        }
        return getAllChains().map((c) => ({
            ...c,
            providers: ["debridge"],
        }));
    }
}
