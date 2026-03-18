import { Hono } from "hono";
import type { BridgeBackend } from "../../../src/backends/types.js";

// Cache: chainId → { data, fetchedAt }
const tokensCache = new Map<number, { data: object; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function createTokensRouter(backends: BridgeBackend[]) {
  const router = new Hono();

  router.get("/", async (c) => {
    const chainIdStr = c.req.query("chainId");
    if (!chainIdStr) {
      return c.json({ error: "Missing required query parameter: chainId" }, 400);
    }
    const chainId = Number(chainIdStr);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return c.json({ error: `Invalid chainId: ${chainIdStr}` }, 400);
    }

    const now = Date.now();
    const cached = tokensCache.get(chainId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return c.json(cached.data);
    }

    // Try backends in order until one returns tokens
    for (const backend of backends) {
      if (!backend.getSupportedTokens) continue;
      try {
        const tokens = await backend.getSupportedTokens(chainId);
        if (!tokens || tokens.length === 0) continue;
        const data = { chainId, tokens, count: tokens.length };
        tokensCache.set(chainId, { data, fetchedAt: now });
        return c.json(data);
      } catch {
        continue;
      }
    }

    return c.json({ chainId, tokens: [], count: 0, note: "No tokens found for this chain" });
  });

  return router;
}
