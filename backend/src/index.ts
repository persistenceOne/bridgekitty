#!/usr/bin/env node
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { RoutingEngine } from "../../src/routing/engine.js";
import { CircuitBreaker } from "../../src/utils/circuit-breaker.js";
import { createBackendsWithFees } from "./services/fee-injector.js";
import { QuoteStore } from "./services/quote-store.js";
import { createQuoteRouter } from "./routes/quote.js";
import { createExecuteRouter } from "./routes/execute.js";
import { createChainsRouter } from "./routes/chains.js";
import { createTokensRouter } from "./routes/tokens.js";
import { createStatusRouter } from "./routes/status.js";
import { healthRouter } from "./routes/health.js";
import { requestLogger } from "./middleware/logging.js";
import { config } from "./config.js";

const backends = createBackendsWithFees();
const engine = new RoutingEngine(backends, new CircuitBreaker());
const quoteStore = new QuoteStore(config.quoteStoreTtlMs);

const app = new Hono();

app.use("*", requestLogger);

app.route("/api/v1/health", healthRouter);
app.route("/api/v1/chains", createChainsRouter(backends));
app.route("/api/v1/tokens", createTokensRouter(backends));
app.route("/api/v1/quote", createQuoteRouter(engine, quoteStore));
app.route("/api/v1/execute", createExecuteRouter(engine, quoteStore));
app.route("/api/v1/status", createStatusRouter(engine));

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  process.stderr.write(JSON.stringify({ type: "error", message: err.message, stack: err.stack }) + "\n");
  return c.json({ error: "Internal server error" }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  process.stderr.write(
    JSON.stringify({ type: "startup", message: `BridgeKitty backend listening on port ${info.port}` }) + "\n"
  );
});
