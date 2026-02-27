import { formatTokenAmount } from "../utils/tokens.js";
import { getBackendChainId, getAllChains } from "../utils/chains.js";
import { buildApproveData } from "../utils/evm.js";
import { estimateGasCostUsd, getGasUnits } from "../utils/gas-estimator.js";
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
            url.searchParams.set("srcChainTokenIn", params.fromTokenAddress);
            url.searchParams.set("srcChainTokenInAmount", params.amountRaw);
            url.searchParams.set("dstChainId", String(dstChainId));
            url.searchParams.set("dstChainTokenOut", params.toTokenAddress);
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
                },
                estimatedTimeSeconds: data.estimation.estimatedFulfillmentDelay ?? 30,
                route: `${srcTokenSymbol} → deBridge DLN → ${dstTokenSymbol}`,
                quoteData: {
                    estimation: data.estimation,
                    order: data.order,
                    params: {
                        srcChainId: params.fromChainId,
                        dstChainId: params.toChainId,
                        srcChainTokenIn: params.fromTokenAddress,
                        dstChainTokenOut: params.toTokenAddress,
                        srcChainTokenInAmount: params.amountRaw,
                        fromAddress: params.fromAddress,
                        toAddress: params.toAddress || params.fromAddress,
                    },
                },
                // deBridge DLN quotes: use estimation expiry if available, else conservative 30s
                expiresAt: data.estimation?.expiration
                    ? new Date(data.estimation.expiration).getTime()
                    : Date.now() + 30_000,
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
        if (!data.tx || !data.tx.to || !data.tx.data) {
            throw new Error("Invalid or missing transaction data in deBridge create-tx response. " +
                "Ensure senderAddress is provided.");
        }
        const orderId = data.orderId ?? `${Date.now()}`;
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
        if (approvalSpender && p.srcChainTokenIn !== "0x0000000000000000000000000000000000000000") {
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
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${err.message}`,
                provider: "debridge",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        // deBridge supports major EVM chains — return our known chains
        // with debridge as a provider
        try {
            const data = await fetchJson(`${BASE_URL}/supported-chains-info`);
            if (data.chains) {
                return Object.entries(data.chains).map(([id, info]) => ({
                    id: Number(id),
                    name: info.chainName ?? `Chain ${id}`,
                    key: (info.chainName ?? `chain-${id}`).toLowerCase().replace(/\s+/g, "-"),
                    providers: ["debridge"],
                }));
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
