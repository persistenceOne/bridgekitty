const BASE_URL = "https://api.interop.persistence.one";
const TIMEOUT_MS = 15_000;
async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Persistence ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
// Persistence Interop currently supports BTC variants on Base and BSC
const SUPPORTED_CHAINS = [
    { id: 8453, name: "Base", key: "base" },
    { id: 56, name: "BNB Chain", key: "bsc" },
];
// Supported BTC token addresses
const BTC_TOKENS = {
    8453: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC" },
    56: { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB" },
};
export class PersistenceBackend {
    name = "persistence";
    async getQuote(params) {
        try {
            // Only support BTC cross-chain between Base and BSC
            const fromBtc = BTC_TOKENS[params.fromChainId];
            const toBtc = BTC_TOKENS[params.toChainId];
            if (!fromBtc || !toBtc)
                return null;
            // Check if the tokens match our supported BTC variants
            if (params.fromTokenAddress.toLowerCase() !== fromBtc.address.toLowerCase() &&
                params.fromTokenAddress.toUpperCase() !== fromBtc.symbol.toUpperCase()) {
                return null;
            }
            const data = await fetchJson(`${BASE_URL}/quotes/request`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sourceChainId: params.fromChainId,
                    destinationChainId: params.toChainId,
                    sourceToken: fromBtc.address,
                    destinationToken: toBtc.address,
                    amount: params.amountRaw,
                    senderAddress: params.fromAddress,
                    recipientAddress: params.toAddress ?? params.fromAddress,
                }),
            });
            if (!data || data.error)
                return null;
            return {
                provider: "persistence",
                outputAmount: data.estimatedOutput ?? data.outputAmount ?? "0",
                outputAmountRaw: data.estimatedOutputRaw ?? params.amountRaw,
                estimatedFeeUsd: data.totalFee ?? 0,
                estimatedTimeSeconds: data.estimatedTime ?? 120,
                route: `${fromBtc.symbol} → Persistence Solver → ${toBtc.symbol}`,
                quoteData: data,
                expiresAt: Date.now() + 60_000,
            };
        }
        catch (err) {
            console.error("[persistence] quote error:", err.message);
            return null;
        }
    }
    async buildTransaction(quote) {
        const data = quote.quoteData;
        // The Persistence Interop flow:
        // 1. Agent approves token spend to the escrow contract
        // 2. Agent calls the escrow contract to lock tokens
        // 3. Submit order to backend
        // The exact tx data should come from the quote response
        if (data.transactionRequest) {
            return {
                to: data.transactionRequest.to,
                data: data.transactionRequest.data,
                value: data.transactionRequest.value ?? "0x0",
                chainId: data.transactionRequest.chainId,
                gasLimit: data.transactionRequest.gasLimit,
                provider: "persistence",
                trackingId: `persistence:${data.orderId ?? Date.now()}`,
            };
        }
        throw new Error("Persistence quote did not include transaction data. Manual order submission may be required via the Persistence Interop frontend.");
    }
    async getStatus(trackingId, meta) {
        try {
            const orderId = meta?.orderId ?? trackingId.replace("persistence:", "");
            const data = await fetchJson(`${BASE_URL}/orders/reclaim-status/${orderId}`);
            const stateMap = {
                pending: "pending",
                filled: "completed",
                completed: "completed",
                failed: "failed",
                refunded: "refunded",
            };
            return {
                state: stateMap[data.status] ?? "in_progress",
                humanReadable: `Persistence Interop: ${data.status ?? "unknown"}`,
                sourceTxHash: data.sourceTxHash,
                destTxHash: data.destinationTxHash,
                provider: "persistence",
                elapsed: 0,
            };
        }
        catch (err) {
            return {
                state: "unknown",
                humanReadable: `Status check failed: ${err.message}`,
                provider: "persistence",
                elapsed: 0,
            };
        }
    }
    async getSupportedChains() {
        return SUPPORTED_CHAINS.map((c) => ({
            ...c,
            providers: ["persistence"],
        }));
    }
}
