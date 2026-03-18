import { Hono } from "hono";
import { RoutingEngine } from "../../../src/routing/engine.js";
import type { QuoteParams } from "../../../src/backends/types.js";
import { BackendValidationError } from "../../../src/backends/types.js";
import type { QuoteStore } from "../services/quote-store.js";
import { logQuote, trackQuoteIds } from "../services/telemetry.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { config } from "../config.js";

export function createQuoteRouter(engine: RoutingEngine, quoteStore: QuoteStore) {
  const router = new Hono();

  router.use("*", rateLimit(config.quoteLimitPerMinute, 60_000, "quote"));

  router.post("/", async (c) => {
    const start = Date.now();
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { fromChainId, toChainId, fromTokenAddress, toTokenAddress, amount, fromAddress } = body;

    if (
      typeof fromChainId !== "number" ||
      typeof toChainId !== "number" ||
      typeof fromTokenAddress !== "string" ||
      typeof toTokenAddress !== "string" ||
      typeof amount !== "string" ||
      typeof fromAddress !== "string"
    ) {
      return c.json(
        {
          error:
            "Missing or invalid required fields: fromChainId, toChainId, fromTokenAddress, toTokenAddress, amount (string), fromAddress",
        },
        400
      );
    }

    const toAddress = typeof body.toAddress === "string" ? body.toAddress : undefined;
    const preference = body.preference === "fastest" ? "fastest" : "cheapest";
    const providers = Array.isArray(body.providers)
      ? (body.providers as unknown[]).filter((p): p is string => typeof p === "string")
      : undefined;

    const params: QuoteParams = {
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      amountRaw: amount,
      fromAddress,
      toAddress,
      preference,
      providers,
    };

    try {
      const quotes = await engine.getQuotes(params);
      const stored = quoteStore.put(quotes, params);
      const failedProviders = engine.getLastFailedProviders();
      const durationMs = Date.now() - start;

      logQuote({
        ip,
        userAgent,
        fromChainId,
        toChainId,
        fromTokenAddress,
        toTokenAddress,
        amount,
        preference,
        providers: providers ?? [],
        quotesReturned: quotes.length,
        durationMs,
      });

      trackQuoteIds(quotes.map((q) => ({ quoteId: q.quoteId, provider: q.backendName })));

      return c.json({
        quotes: stored.map((s) => ({
          quoteId: s.quoteId,
          provider: s.quote.provider,
          backendName: s.quote.backendName,
          outputAmount: s.quote.outputAmount,
          outputAmountRaw: s.quote.outputAmountRaw,
          minOutputAmount: s.quote.minOutputAmount,
          minOutputAmountRaw: s.quote.minOutputAmountRaw,
          outputDecimals: s.quote.outputDecimals,
          estimatedGasCostUsd: s.quote.estimatedGasCostUsd,
          estimatedFeeUsd: s.quote.estimatedFeeUsd,
          feeBreakdown: s.quote.feeBreakdown,
          estimatedTimeSeconds: s.quote.estimatedTimeSeconds,
          route: s.quote.route,
          expiresAt: s.quote.expiresAt,
          ttlExpiresAt: s.ttlExpiresAt,
        })),
        failedProviders,
        durationMs,
      });
    } catch (err) {
      if (err instanceof BackendValidationError) {
        return c.json({ error: err.message }, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Quote failed", details: msg }, 500);
    }
  });

  return router;
}
