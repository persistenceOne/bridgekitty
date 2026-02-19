import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";

export class RoutingEngine {
  private backends: BridgeBackend[];
  private quoteCache = new Map<string, { quote: BridgeQuote; expiresAt: number }>();

  constructor(backends: BridgeBackend[]) {
    this.backends = backends;
  }

  async getQuotes(params: QuoteParams): Promise<BridgeQuote[]> {
    const results = await Promise.allSettled(
      this.backends.map((b) =>
        Promise.race([
          b.getQuote(params),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
        ])
      )
    );

    const quotes = results
      .filter(
        (r): r is PromiseFulfilledResult<BridgeQuote | null> =>
          r.status === "fulfilled"
      )
      .map((r) => r.value)
      .filter((q): q is BridgeQuote => q !== null);

    // Sort by preference
    if (params.preference === "fastest") {
      quotes.sort((a, b) => a.estimatedTimeSeconds - b.estimatedTimeSeconds);
    } else {
      // Cheapest = highest output (best deal for the user)
      quotes.sort(
        (a, b) => Number(BigInt(b.outputAmountRaw) - BigInt(a.outputAmountRaw))
      );
    }

    // Cache quotes for execution
    for (const q of quotes) {
      const cacheKey = `${q.provider}:${Date.now()}`;
      this.quoteCache.set(cacheKey, { quote: q, expiresAt: q.expiresAt });
      (q as any)._cacheKey = cacheKey;
    }

    // Clean expired
    const now = Date.now();
    for (const [key, val] of this.quoteCache) {
      if (val.expiresAt < now) this.quoteCache.delete(key);
    }

    return quotes;
  }

  getCachedQuote(cacheKey: string): BridgeQuote | null {
    const entry = this.quoteCache.get(cacheKey);
    if (!entry || entry.expiresAt < Date.now()) {
      this.quoteCache.delete(cacheKey);
      return null;
    }
    return entry.quote;
  }

  getBackend(name: string): BridgeBackend | undefined {
    return this.backends.find((b) => b.name === name);
  }

  getAllBackends(): BridgeBackend[] {
    return this.backends;
  }
}
