import { formatTokenAmount } from "../utils/tokens.js";
const BASE_URL = "https://li.quest/v1";
const TIMEOUT_MS = 15_000;
async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`LI.FI ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
export class LiFiBackend {
    name = "lifi";
    apiKey;
    integrator;
    integratorFee;
    constructor(apiKey, integrator, integratorFee) {
        this.apiKey = apiKey;
        this.integrator = integrator;
        this.integratorFee = integratorFee;
    }
    headers() {
        const h = { Accept: "application/json" };
        if (this.apiKey)
            h["x-lifi-api-key"] = this.apiKey;
        return h;
    }
    async getQuote(params) {
        const quotes = await this.getQuotes(params);
        return quotes.length > 0 ? quotes[0] : null;
    }
    /**
     * Fetch multiple routes via LI.FI /advanced/routes endpoint.
     * Returns up to 5 route options with full fee breakdowns.
     */
    async getQuotes(params) {
        try {
            const body = {
                fromChainId: params.fromChainId,
                toChainId: params.toChainId,
                fromTokenAddress: params.fromTokenAddress,
                toTokenAddress: params.toTokenAddress,
                fromAmount: params.amountRaw,
                fromAddress: params.fromAddress,
                toAddress: params.toAddress || params.fromAddress,
                options: {
                    order: params.preference === "fastest" ? "FASTEST" : "CHEAPEST",
                    slippage: 0.005,
                    maxPriceImpact: 0.4,
                    allowSwitchChain: false,
                },
            };
            if (this.integrator) {
                body.options.integrator = this.integrator;
                if (this.integratorFee)
                    body.options.fee = parseFloat(this.integratorFee);
            }
            const data = await fetchJson(`${BASE_URL}/advanced/routes`, {
                method: "POST",
                headers: { ...this.headers(), "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const routes = data.routes ?? [];
            if (routes.length === 0)
                return [];
            const integratorFeePercent = this.integratorFee
                ? `${(parseFloat(this.integratorFee) * 100).toFixed(1)}%`
                : null;
            return routes.slice(0, 5).map((route) => {
                const steps = route.steps ?? [];
                const firstStep = steps[0];
                const lastStep = steps[steps.length - 1];
                // Fee breakdown from route data
                const gasCostUsd = route.gasCostUSD ? parseFloat(route.gasCostUSD) : 0;
                // Extract protocol fees from step fee costs
                let protocolFeeUsd = 0;
                let integratorFeeUsd = 0;
                for (const step of steps) {
                    const estimate = step.estimate ?? {};
                    const feeCosts = estimate.feeCosts ?? [];
                    for (const fee of feeCosts) {
                        const usd = parseFloat(fee.amountUSD || "0");
                        if (fee.name?.toLowerCase().includes("integrator") ||
                            fee.name?.toLowerCase().includes("affiliate")) {
                            integratorFeeUsd += usd;
                        }
                        else {
                            protocolFeeUsd += usd;
                        }
                    }
                }
                const totalFeeUsd = gasCostUsd + protocolFeeUsd + integratorFeeUsd;
                const feeBreakdown = {
                    gasCostUsd: Math.round(gasCostUsd * 100) / 100,
                    protocolFeeUsd: Math.round(protocolFeeUsd * 100) / 100,
                    integratorFeeUsd: Math.round(integratorFeeUsd * 100) / 100,
                    integratorFeePercent,
                    totalFeeUsd: Math.round(totalFeeUsd * 100) / 100,
                };
                // Build human-readable route description
                const toolNames = steps
                    .map((s) => s.toolDetails?.name ?? s.tool ?? "?")
                    .join(" → ");
                const fromSymbol = firstStep?.action?.fromToken?.symbol ?? "?";
                const toSymbol = lastStep?.action?.toToken?.symbol ?? "?";
                const toDecimals = lastStep?.action?.toToken?.decimals ?? 18;
                return {
                    provider: `${toolNames} via LI.FI`,
                    outputAmount: route.toAmount
                        ? formatTokenAmount(route.toAmount, toDecimals)
                        : "0",
                    outputAmountRaw: route.toAmount ?? "0",
                    estimatedFeeUsd: totalFeeUsd,
                    feeBreakdown,
                    estimatedTimeSeconds: steps.reduce((sum, s) => sum + (s.estimate?.executionDuration ?? 0), 0) || 300,
                    route: `${fromSymbol} → ${toolNames} → ${toSymbol}`,
                    quoteData: route,
                    expiresAt: Date.now() + 60_000,
                };
            });
        }
        catch (err) {
            console.error("[lifi] advanced/routes error:", err.message);
            return [];
        }
    }
    async buildTransaction(quote) {
        const route = quote.quoteData;
        // For /advanced/routes, get step transaction from the first step
        const step = route.steps?.[0];
        if (!step)
            throw new Error("No steps in LI.FI route");
        // Call /advanced/stepTransaction to get the actual tx data
        const stepData = await fetchJson(`${BASE_URL}/advanced/stepTransaction`, {
            method: "POST",
            headers: { ...this.headers(), "Content-Type": "application/json" },
            body: JSON.stringify(step),
        });
        const txReq = stepData.transactionRequest;
        if (!txReq)
            throw new Error("No transactionRequest in LI.FI step response");
        const toolName = step.tool ?? step.toolDetails?.name ?? "unknown";
        const result = {
            to: txReq.to,
            data: txReq.data,
            value: txReq.value ?? "0x0",
            chainId: txReq.chainId,
            gasLimit: txReq.gasLimit,
            provider: "lifi",
            trackingId: `lifi:${toolName}:${Date.now()}`,
        };
        // Check if approval is needed
        const estimate = stepData.estimate ?? step.estimate;
        const action = stepData.action ?? step.action;
        if (estimate?.approvalAddress && action?.fromToken?.address) {
            const tokenAddr = action.fromToken.address;
            // Non-native tokens may need approval
            if (tokenAddr !== "0x0000000000000000000000000000000000000000") {
                result.approvalTx = {
                    to: tokenAddr,
                    data: buildApproveData(estimate.approvalAddress, action.fromAmount),
                    value: "0x0",
                    chainId: txReq.chainId,
                };
            }
        }
        return result;
    }
    async getStatus(trackingId, meta) {
        try {
            const txHash = meta?.txHash;
            const fromChain = meta?.fromChain;
            const toChain = meta?.toChain;
            if (!txHash) {
                return {
                    state: "unknown",
                    humanReadable: "No transaction hash provided for status check",
                    provider: "lifi",
                    elapsed: 0,
                };
            }
            const url = new URL(`${BASE_URL}/status`);
            url.searchParams.set("txHash", txHash);
            if (fromChain)
                url.searchParams.set("fromChain", fromChain);
            if (toChain)
                url.searchParams.set("toChain", toChain);
            const data = await fetchJson(url.toString(), { headers: this.headers() });
            const stateMap = {
                NOT_FOUND: "pending",
                PENDING: "pending",
                DONE: "completed",
                FAILED: "failed",
            };
            const elapsed = data.sending?.timestamp
                ? Math.floor((Date.now() - data.sending.timestamp * 1000) / 1000)
                : 0;
            return {
                state: stateMap[data.status] ?? "in_progress",
                humanReadable: `Bridge via ${data.tool ?? "LI.FI"}: ${data.status ?? "unknown"}${data.substatus ? ` (${data.substatus})` : ""}`,
                sourceTxHash: data.sending?.txHash,
                destTxHash: data.receiving?.txHash,
                provider: "lifi",
                elapsed,
            };
        }
        catch (err) {
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${err.message}`,
                provider: "lifi",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        const data = await fetchJson(`${BASE_URL}/chains`, {
            headers: this.headers(),
        });
        return (data.chains ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            key: c.key,
            logoURI: c.logoURI,
            providers: ["lifi"],
        }));
    }
    async getSupportedTokens(chainId) {
        const data = await fetchJson(`${BASE_URL}/tokens?chains=${chainId}`, { headers: this.headers() });
        const tokens = data.tokens?.[String(chainId)] ?? [];
        return tokens.slice(0, 50).map((t) => ({
            symbol: t.symbol,
            name: t.name,
            address: t.address,
            decimals: t.decimals,
            chainId: t.chainId,
            logoURI: t.logoURI,
        }));
    }
}
function buildApproveData(spender, amount) {
    // ERC20 approve(address,uint256) selector = 0x095ea7b3
    const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
    const amountHex = BigInt(amount).toString(16).padStart(64, "0");
    return `0x095ea7b3${spenderPadded}${amountHex}`;
}
