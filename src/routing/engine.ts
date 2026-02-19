import crypto from "node:crypto";
import type { BridgeBackend, BridgeQuote, QuoteParams } from "../backends/types.js";

export interface CachedQuote extends BridgeQuote {
  quoteId: string;
}

export class RoutingEngine {
  private backends: BridgeBackend[];
  private quoteCache = new Map<string, { quote: BridgeQuote; expiresAt: number }>();

  constructor(backends: BridgeBackend[]) {
    this.backends = backends;
  }

  async getQuotes(params: QuoteParams): Promise<CachedQuote[]> {
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
      quotes.sort((a, b) => {
        try {
          const diff = BigInt(b.outputAmountRaw) - BigInt(a.outputAmountRaw);
          return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        } catch {
          return 0;
        }
      });
    }

    // Cache quotes for execution and assign stable IDs
    const cachedQuotes: CachedQuote[] = [];
    for (const q of quotes) {
      const quoteId = crypto.randomUUID();
      this.quoteCache.set(quoteId, { quote: q, expiresAt: q.expiresAt });
      cachedQuotes.push({ ...q, quoteId });
    }

    // Clean expired entries
    const now = Date.now();
    for (const [key, val] of this.quoteCache) {
      if (val.expiresAt < now) this.quoteCache.delete(key);
    }

    return cachedQuotes;
  }

  getCachedQuote(quoteId: string): BridgeQuote | null {
    const entry = this.quoteCache.get(quoteId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.quoteCache.delete(quoteId);
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
