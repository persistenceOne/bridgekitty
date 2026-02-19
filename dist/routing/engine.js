export class RoutingEngine {
    backends;
    quoteCache = new Map();
    constructor(backends) {
        this.backends = backends;
    }
    async getQuotes(params) {
        const results = await Promise.allSettled(this.backends.map((b) => Promise.race([
            b.getQuote(params),
            new Promise((resolve) => setTimeout(() => resolve(null), 12_000)),
        ])));
        const quotes = results
            .filter((r) => r.status === "fulfilled")
            .map((r) => r.value)
            .filter((q) => q !== null);
        // Sort by preference
        if (params.preference === "fastest") {
            quotes.sort((a, b) => a.estimatedTimeSeconds - b.estimatedTimeSeconds);
        }
        else {
            // Cheapest = highest output (best deal for the user)
            quotes.sort((a, b) => Number(BigInt(b.outputAmountRaw) - BigInt(a.outputAmountRaw)));
        }
        // Cache quotes for execution
        for (const q of quotes) {
            const cacheKey = `${q.provider}:${Date.now()}`;
            this.quoteCache.set(cacheKey, { quote: q, expiresAt: q.expiresAt });
            q._cacheKey = cacheKey;
        }
        // Clean expired
        const now = Date.now();
        for (const [key, val] of this.quoteCache) {
            if (val.expiresAt < now)
                this.quoteCache.delete(key);
        }
        return quotes;
    }
    getCachedQuote(cacheKey) {
        const entry = this.quoteCache.get(cacheKey);
        if (!entry || entry.expiresAt < Date.now()) {
            this.quoteCache.delete(cacheKey);
            return null;
        }
        return entry.quote;
    }
    getBackend(name) {
        return this.backends.find((b) => b.name === name);
    }
    getAllBackends() {
        return this.backends;
    }
}
