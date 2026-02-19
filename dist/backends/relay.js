import { formatTokenAmount } from "../utils/tokens.js";
import { getAllChains } from "../utils/chains.js";
const BASE_URL = "https://api.relay.link";
const TIMEOUT_MS = 15_000;
async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Relay ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
const NATIVE = "0x0000000000000000000000000000000000000000";
function buildApproveData(spender, amount) {
    const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
    const amountHex = BigInt(amount).toString(16).padStart(64, "0");
    return `0x095ea7b3${spenderPadded}${amountHex}`;
}
export class RelayBackend {
    name = "relay";
    async getQuote(params) {
        try {
            const body = {
                user: params.fromAddress,
                originChainId: params.fromChainId,
                destinationChainId: params.toChainId,
                originCurrency: params.fromTokenAddress === NATIVE
                    ? "0x0000000000000000000000000000000000000000"
                    : params.fromTokenAddress,
                destinationCurrency: params.toTokenAddress === NATIVE
                    ? "0x0000000000000000000000000000000000000000"
                    : params.toTokenAddress,
                amount: params.amountRaw,
                tradeType: "EXACT_INPUT",
            };
            if (params.toAddress) {
                body.recipient = params.toAddress;
            }
            const data = await fetchJson(`${BASE_URL}/quote`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!data.steps || data.steps.length === 0)
                return null;
            // Extract output details from the quote
            const details = data.details ?? {};
            const outputRaw = details.currencyOut?.amount ?? "0";
            const outputDecimals = details.currencyOut?.currency?.decimals ?? 18;
            const srcSymbol = details.currencyIn?.currency?.symbol ?? "?";
            const dstSymbol = details.currencyOut?.currency?.symbol ?? "?";
            const feeUsd = Number(details.totalFee?.usd ?? 0);
            const timeEstimate = details.timeEstimate ?? 60;
            return {
                provider: "relay",
                outputAmount: formatTokenAmount(outputRaw, outputDecimals),
                outputAmountRaw: outputRaw,
                estimatedFeeUsd: feeUsd,
                estimatedTimeSeconds: timeEstimate,
                route: `${srcSymbol} → Relay → ${dstSymbol}`,
                quoteData: data,
                expiresAt: Date.now() + 60_000,
            };
        }
        catch (err) {
            console.error("[relay] quote error:", err.message);
            return null;
        }
    }
    async buildTransaction(quote) {
        const data = quote.quoteData;
        // Relay returns steps, each step has items, each item has a transaction
        const steps = data.steps ?? [];
        if (steps.length === 0)
            throw new Error("No steps in Relay quote");
        // Find the main transaction step (usually the first or only step)
        let mainTx = null;
        let approvalTx = null;
        for (const step of steps) {
            for (const item of step.items ?? []) {
                if (item.data?.data) {
                    if (step.id === "approve" || item.id === "approve") {
                        approvalTx = item.data;
                    }
                    else {
                        mainTx = item.data;
                    }
                }
            }
        }
        if (!mainTx)
            throw new Error("No transaction data in Relay quote steps");
        const result = {
            to: mainTx.to,
            data: mainTx.data,
            value: mainTx.value ? `0x${BigInt(mainTx.value).toString(16)}` : "0x0",
            chainId: mainTx.chainId ?? data.details?.currencyIn?.currency?.chainId ?? 0,
            provider: "relay",
            trackingId: `relay:${data.requestId ?? Date.now()}`,
        };
        if (approvalTx) {
            result.approvalTx = {
                to: approvalTx.to,
                data: approvalTx.data,
                value: "0x0",
                chainId: approvalTx.chainId ?? result.chainId,
            };
        }
        return result;
    }
    async getStatus(trackingId, meta) {
        try {
            const txHash = meta?.txHash;
            if (!txHash) {
                return {
                    state: "unknown",
                    humanReadable: "No transaction hash provided for Relay status check",
                    provider: "relay",
                    elapsed: 0,
                };
            }
            const chainId = meta?.fromChain ?? "1";
            const data = await fetchJson(`${BASE_URL}/intents/status/v2?chainId=${chainId}&txHash=${txHash}`);
            const stateMap = {
                pending: "pending",
                waiting: "pending",
                delayed: "in_progress",
                receiving: "in_progress",
                success: "completed",
                failure: "failed",
                refund: "refunded",
            };
            return {
                state: stateMap[data.status] ?? "in_progress",
                humanReadable: `Relay bridge: ${data.status ?? "unknown"}`,
                sourceTxHash: txHash,
                destTxHash: data.txHashes?.find((t) => t.chainId !== Number(chainId))?.txHash,
                provider: "relay",
                elapsed: 0,
            };
        }
        catch (err) {
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${err.message}`,
                provider: "relay",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        try {
            const data = await fetchJson(`${BASE_URL}/chains`);
            if (Array.isArray(data.chains)) {
                return data.chains.map((c) => ({
                    id: c.id,
                    name: c.name ?? `Chain ${c.id}`,
                    key: (c.name ?? `chain-${c.id}`).toLowerCase().replace(/\s+/g, "-"),
                    logoURI: c.icon,
                    providers: ["relay"],
                }));
            }
        }
        catch {
            // Fallback
        }
        return getAllChains().map((c) => ({
            ...c,
            providers: ["relay"],
        }));
    }
}
