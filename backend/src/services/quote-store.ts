import crypto from "node:crypto";
import type { BridgeQuote, QuoteParams } from "../../../src/backends/types.js";
import type { CachedQuote } from "../../../src/routing/engine.js";

export interface StoredQuote {
  quoteId: string;
  quote: CachedQuote;
  params: QuoteParams;
  createdAt: number;
  ttlExpiresAt: number; // when the store entry expires (TTL-based)
}

/**
 * In-memory quote store with per-entry TTL.
 * Thread-safe (single-threaded Node.js event loop).
 */
export class QuoteStore {
  private store = new Map<string, StoredQuote>();
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Store a set of quotes (from one getQuotes call) and return them with stable IDs.
   * The quoteId assigned by the routing engine is preserved.
   */
  put(quotes: CachedQuote[], params: QuoteParams): StoredQuote[] {
    const now = Date.now();
    this.evict();

    const stored: StoredQuote[] = [];
    for (const quote of quotes) {
      const entry: StoredQuote = {
        quoteId: quote.quoteId,
        quote,
        params,
        createdAt: now,
        ttlExpiresAt: now + this.ttlMs,
      };
      this.store.set(quote.quoteId, entry);
      stored.push(entry);
    }
    return stored;
  }

  /**
   * Look up a quote by ID. Returns null if not found or TTL expired.
   */
  get(quoteId: string): StoredQuote | null {
    const entry = this.store.get(quoteId);
    if (!entry) return null;
    if (Date.now() > entry.ttlExpiresAt) {
      this.store.delete(quoteId);
      return null;
    }
    return entry;
  }

  /**
   * Look up a quote even if TTL-expired (for auto-refresh flows).
   */
  getWithExpiry(quoteId: string): { entry: StoredQuote; expired: boolean } | null {
    const entry = this.store.get(quoteId);
    if (!entry) return null;
    const expired = Date.now() > entry.ttlExpiresAt;
    return { entry, expired };
  }

  /**
   * Remove all entries whose TTL has elapsed.
   */
  evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now > entry.ttlExpiresAt) {
        this.store.delete(id);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}
