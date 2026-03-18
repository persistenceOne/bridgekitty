import { Hono } from "hono";
import { RoutingEngine } from "../../../src/routing/engine.js";
import type { QuoteStore } from "../services/quote-store.js";
import { logExecute } from "../services/telemetry.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { config } from "../config.js";

// Prevent duplicate execution of the same quote
const executingQuotes = new Set<string>();

export function createExecuteRouter(engine: RoutingEngine, quoteStore: QuoteStore) {
  const router = new Hono();

  router.use("*", rateLimit(config.executeLimitPerMinute, 60_000, "execute"));

  router.post("/", async (c) => {
    const start = Date.now();
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { quoteId } = body;
    if (typeof quoteId !== "string" || !quoteId) {
      return c.json({ error: "Missing required field: quoteId" }, 400);
    }

    // Look up the quote in the store
    const stored = quoteStore.get(quoteId);
    if (!stored) {
      return c.json(
        { error: "Quote not found or expired. Call POST /api/v1/quote again to get a fresh quote." },
        404
      );
    }

    const { quote } = stored;

    // Check quote hasn't expired
    const BUILD_BUFFER_MS = 15_000;
    if (quote.expiresAt <= Date.now() + BUILD_BUFFER_MS) {
      return c.json(
        { error: "Quote is about to expire. Call POST /api/v1/quote again to get a fresh quote." },
        410
      );
    }

    // Prevent double-execution
    if (executingQuotes.has(quoteId)) {
      return c.json({ error: "This quote is already being executed. Please wait." }, 409);
    }

    executingQuotes.add(quoteId);
    try {
      const backend = engine.getBackend(quote.backendName);
      if (!backend) {
        return c.json({ error: `Backend '${quote.backendName}' not available` }, 500);
      }

      const txRequest = await backend.buildTransaction(quote);

      const durationMs = Date.now() - start;
      logExecute({ ip, quoteId, provider: quote.backendName, success: true, durationMs });

      return c.json({
        quoteId,
        provider: txRequest.provider,
        trackingId: txRequest.trackingId,
        transaction: {
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value,
          chainId: txRequest.chainId,
          gasLimit: txRequest.gasLimit,
        },
        approvalTransaction: txRequest.approvalTx
          ? {
              to: txRequest.approvalTx.to,
              data: txRequest.approvalTx.data,
              value: txRequest.approvalTx.value,
              chainId: txRequest.approvalTx.chainId,
            }
          : undefined,
        needsPostApprovalBuild: txRequest.needsPostApprovalBuild,
        eip712: txRequest.eip712,
        solanaTransaction: txRequest.solanaTransaction,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - start;
      logExecute({ ip, quoteId, provider: stored.quote.backendName, success: false, durationMs, error: msg });
      return c.json({ error: "Execute failed", details: msg }, 500);
    } finally {
      executingQuotes.delete(quoteId);
    }
  });

  return router;
}
