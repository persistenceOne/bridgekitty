/**
 * Structured telemetry/logging service.
 * Emits JSON lines to stdout for easy ingestion by log aggregators.
 */

export interface QuoteEvent {
  type: "quote";
  timestamp: string;
  ip: string;
  userAgent: string;
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  preference: string;
  providers: string[];
  quotesReturned: number;
  durationMs: number;
}

export interface ExecuteEvent {
  type: "execute";
  timestamp: string;
  ip: string;
  quoteId: string;
  provider: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface StatusEvent {
  type: "status";
  timestamp: string;
  trackingId: string;
  provider: string;
  state: string;
}

export type TelemetryEvent = QuoteEvent | ExecuteEvent | StatusEvent;

// Conversion rate tracking: quoteId → whether execute was called
const quoteToExecuteMap = new Map<string, { provider: string; quoted: number }>();
// Provider stats: provider name → { quotes, executes }
const providerStats = new Map<string, { quotes: number; executes: number }>();

function emit(event: TelemetryEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

export function logQuote(event: Omit<QuoteEvent, "type" | "timestamp">): void {
  emit({ type: "quote", timestamp: new Date().toISOString(), ...event });

  // Track per-provider stats
  for (const p of event.providers) {
    const s = providerStats.get(p) ?? { quotes: 0, executes: 0 };
    s.quotes++;
    providerStats.set(p, s);
  }
}

export function trackQuoteIds(quoteIds: Array<{ quoteId: string; provider: string }>): void {
  const now = Date.now();
  for (const { quoteId, provider } of quoteIds) {
    quoteToExecuteMap.set(quoteId, { provider, quoted: now });
  }
  // Clean up old entries (> 10 min)
  for (const [id, val] of quoteToExecuteMap) {
    if (now - val.quoted > 10 * 60 * 1000) quoteToExecuteMap.delete(id);
  }
}

export function logExecute(event: Omit<ExecuteEvent, "type" | "timestamp">): void {
  emit({ type: "execute", timestamp: new Date().toISOString(), ...event });

  // Track conversion
  const entry = quoteToExecuteMap.get(event.quoteId);
  const provider = entry?.provider ?? event.provider;
  const s = providerStats.get(provider) ?? { quotes: 0, executes: 0 };
  s.executes++;
  providerStats.set(provider, s);
}

export function logStatus(event: Omit<StatusEvent, "type" | "timestamp">): void {
  emit({ type: "status", timestamp: new Date().toISOString(), ...event });
}

/**
 * Get quote-to-execute conversion rates per provider.
 */
export function getConversionRates(): Record<string, { quotes: number; executes: number; rate: string }> {
  const result: Record<string, { quotes: number; executes: number; rate: string }> = {};
  for (const [provider, stats] of providerStats) {
    const rate = stats.quotes > 0
      ? `${((stats.executes / stats.quotes) * 100).toFixed(1)}%`
      : "0%";
    result[provider] = { ...stats, rate };
  }
  return result;
}
