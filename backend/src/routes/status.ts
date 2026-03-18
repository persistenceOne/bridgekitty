import { Hono } from "hono";
import { RoutingEngine } from "../../../src/routing/engine.js";
import { logStatus } from "../services/telemetry.js";

export function createStatusRouter(engine: RoutingEngine) {
  const router = new Hono();

  router.get("/:trackingId", async (c) => {
    const trackingId = c.req.param("trackingId");
    if (!trackingId) {
      return c.json({ error: "Missing trackingId" }, 400);
    }

    // Provider name is encoded as the first segment: "lifi:txHash" or "debridge:orderId"
    let providerName = c.req.query("provider");
    if (!providerName) {
      providerName = trackingId.split(":")[0];
    }
    if (!providerName) {
      return c.json({ error: "Cannot determine provider from trackingId. Pass ?provider=<name>" }, 400);
    }

    const backend = engine.getBackend(providerName);
    if (!backend) {
      const available = engine.getAllBackends().map((b) => b.name).join(", ");
      return c.json({ error: `Unknown provider '${providerName}'. Available: ${available}` }, 404);
    }

    // Optional metadata passed as query params (e.g. fromChainId, toChainId for LI.FI)
    const meta: Record<string, string> = {};
    for (const [key, val] of Object.entries(c.req.query())) {
      if (key !== "provider" && typeof val === "string") meta[key] = val;
    }

    try {
      const status = await backend.getStatus(trackingId, Object.keys(meta).length > 0 ? meta : undefined);
      logStatus({ trackingId, provider: providerName, state: status.state });
      return c.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Status check failed", details: msg }, 500);
    }
  });

  return router;
}
