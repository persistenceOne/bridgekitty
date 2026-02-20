import { formatTokenAmount } from "../utils/tokens.js";
import { getAllChains } from "../utils/chains.js";
const BASE_URL = "https://app.across.to/api";
const TIMEOUT_MS = 15_000;
async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Across ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
function buildApproveData(spender, amount) {
    const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
    const amountHex = BigInt(amount).toString(16).padStart(64, "0");
    return `0x095ea7b3${spenderPadded}${amountHex}`;
}
// Across SpokePool addresses per chain
const SPOKE_POOLS = {
    1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
    10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
    137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
    42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
    8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
    59144: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75",
    534352: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
    324: "0xE0B015E54d54fc84a6cB9B666099c46adE3335fF",
};
export class AcrossBackend {
    name = "across";
    referrer;
    constructor(referrer) {
        this.referrer = referrer;
    }
    async getQuote(params) {
        try {
            // Across only supports same-token bridging (e.g. USDC→USDC across chains).
            // Skip cross-token swaps — those should go through aggregators like LI.FI.
            if (params.fromTokenAddress.toLowerCase() !== params.toTokenAddress.toLowerCase()) {
                return null;
            }
            // Across uses suggested-fees to get the fee structure for a route
            const url = new URL(`${BASE_URL}/suggested-fees`);
            url.searchParams.set("originChainId", String(params.fromChainId));
            url.searchParams.set("destinationChainId", String(params.toChainId));
            url.searchParams.set("token", params.fromTokenAddress);
            url.searchParams.set("amount", params.amountRaw);
            if (this.referrer) {
                url.searchParams.set("referrer", this.referrer);
            }
            const data = await fetchJson(url.toString());
            if (!data.totalRelayFee)
                return null;
            const inputBig = BigInt(params.amountRaw);
            const totalFeeBig = BigInt(data.totalRelayFee.total ?? "0");
            const outputBig = inputBig - totalFeeBig;
            if (outputBig <= 0n)
                return null;
            const outputRaw = outputBig.toString();
            const decimals = params.fromTokenDecimals ?? 18;
            const feeUsd = Number(data.totalRelayFee.total ?? "0") / Math.pow(10, decimals);
            const estimatedFillTime = data.estimatedFillTimeSec ?? 120;
            return {
                provider: "Across (direct)",
                outputAmount: formatTokenAmount(outputRaw, decimals),
                outputAmountRaw: outputRaw,
                estimatedFeeUsd: feeUsd,
                feeBreakdown: { gasCostUsd: 0, protocolFeeUsd: feeUsd, integratorFeeUsd: 0, integratorFeePercent: null, totalFeeUsd: feeUsd },
                estimatedTimeSeconds: estimatedFillTime,
                route: `Across Protocol (fast bridge)`,
                quoteData: {
                    fees: data,
                    params: {
                        fromChainId: params.fromChainId,
                        toChainId: params.toChainId,
                        fromTokenAddress: params.fromTokenAddress,
                        toTokenAddress: params.toTokenAddress,
                        amountRaw: params.amountRaw,
                        fromAddress: params.fromAddress,
                        toAddress: params.toAddress || params.fromAddress,
                        outputRaw,
                    },
                    spokePool: SPOKE_POOLS[params.fromChainId],
                    timestamp: data.timestamp ?? Math.floor(Date.now() / 1000),
                    exclusiveRelayer: data.exclusiveRelayer ?? "0x0000000000000000000000000000000000000000",
                    exclusivityDeadline: data.exclusivityDeadline ?? 0,
                },
                expiresAt: Date.now() + 60_000,
            };
        }
        catch (err) {
            console.error("[across] quote error:", err.message);
            return null;
        }
    }
    async buildTransaction(quote) {
        const qd = quote.quoteData;
        const p = qd.params;
        const spokePool = qd.spokePool;
        if (!spokePool) {
            throw new Error(`Across: no SpokePool address for chain ${p.fromChainId}`);
        }
        // Build depositV3 calldata for Across SpokePool
        // depositV3(address depositor, address recipient, address inputToken, address outputToken,
        //           uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId,
        //           address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline,
        //           uint32 exclusivityDeadline, bytes message)
        const selector = "0xe7a050aa"; // depositV3 selector
        const depositor = p.fromAddress.toLowerCase().replace("0x", "").padStart(64, "0");
        const recipient = (p.toAddress || p.fromAddress).toLowerCase().replace("0x", "").padStart(64, "0");
        const inputToken = p.fromTokenAddress.toLowerCase().replace("0x", "").padStart(64, "0");
        const outputToken = p.toTokenAddress.toLowerCase().replace("0x", "").padStart(64, "0");
        const inputAmount = BigInt(p.amountRaw).toString(16).padStart(64, "0");
        const outputAmount = BigInt(p.outputRaw).toString(16).padStart(64, "0");
        const destChainId = BigInt(p.toChainId).toString(16).padStart(64, "0");
        const exclusiveRelayer = (qd.exclusiveRelayer ?? "0x0000000000000000000000000000000000000000")
            .toLowerCase().replace("0x", "").padStart(64, "0");
        const quoteTimestamp = (qd.timestamp ?? Math.floor(Date.now() / 1000)).toString(16).padStart(64, "0");
        // Fill deadline: 1 hour from now
        const fillDeadline = (Math.floor(Date.now() / 1000) + 3600).toString(16).padStart(64, "0");
        const exclusivityDeadline = (qd.exclusivityDeadline ?? 0).toString(16).padStart(64, "0");
        // Message offset and empty message
        const messageOffset = (12 * 32).toString(16).padStart(64, "0"); // offset to message bytes
        const messageLength = "0".padStart(64, "0"); // empty message
        const calldata = `${selector}${depositor}${recipient}${inputToken}${outputToken}${inputAmount}${outputAmount}${destChainId}${exclusiveRelayer}${quoteTimestamp}${fillDeadline}${exclusivityDeadline}${messageOffset}${messageLength}`;
        const isNative = p.fromTokenAddress === "0x0000000000000000000000000000000000000000";
        const result = {
            to: spokePool,
            data: calldata,
            value: isNative ? `0x${BigInt(p.amountRaw).toString(16)}` : "0x0",
            chainId: p.fromChainId,
            provider: "across",
            trackingId: `across:${p.fromChainId}:${Date.now()}`,
        };
        // Add approval for ERC20 tokens
        if (!isNative) {
            result.approvalTx = {
                to: p.fromTokenAddress,
                data: buildApproveData(spokePool, p.amountRaw),
                value: "0x0",
                chainId: p.fromChainId,
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
                    humanReadable: "No transaction hash provided for Across status check",
                    provider: "across",
                    elapsed: 0,
                };
            }
            const fromChain = meta?.fromChain ?? "1";
            const url = new URL(`${BASE_URL}/deposit/status`);
            url.searchParams.set("originChainId", fromChain);
            url.searchParams.set("depositTxHash", txHash);
            const data = await fetchJson(url.toString());
            const stateMap = {
                pending: "pending",
                filled: "completed",
                expired: "failed",
                slowfill: "in_progress",
            };
            return {
                state: stateMap[data.status] ?? "in_progress",
                humanReadable: `Across bridge: ${data.status ?? "unknown"}`,
                sourceTxHash: txHash,
                destTxHash: data.fillTx,
                provider: "across",
                elapsed: 0,
            };
        }
        catch (err) {
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${err.message}`,
                provider: "across",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        try {
            const data = await fetchJson(`${BASE_URL}/available-routes`);
            if (Array.isArray(data)) {
                const chainIds = new Set();
                for (const route of data) {
                    if (route.originChainId)
                        chainIds.add(route.originChainId);
                    if (route.destinationChainId)
                        chainIds.add(route.destinationChainId);
                }
                const chains = getAllChains();
                return Array.from(chainIds).map((id) => {
                    const known = chains.find((c) => c.id === id);
                    return {
                        id,
                        name: known?.name ?? `Chain ${id}`,
                        key: known?.key ?? `chain-${id}`,
                        providers: ["across"],
                    };
                });
            }
        }
        catch {
            // Fallback
        }
        return Object.keys(SPOKE_POOLS).map((id) => {
            const chains = getAllChains();
            const known = chains.find((c) => c.id === Number(id));
            return {
                id: Number(id),
                name: known?.name ?? `Chain ${id}`,
                key: known?.key ?? `chain-${id}`,
                providers: ["across"],
            };
        });
    }
}
