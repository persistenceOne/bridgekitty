import { Hono } from "hono";
import type { BridgeBackend } from "../../../src/backends/types.js";

// Simple in-process cache for chains (refreshed every 10 minutes)
let chainsCache: { data: object; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function createChainsRouter(backends: BridgeBackend[]) {
  const router = new Hono();

  router.get("/", async (c) => {
    const now = Date.now();
    if (chainsCache && now - chainsCache.fetchedAt < CACHE_TTL_MS) {
      return c.json(chainsCache.data);
    }

    // Fetch from all backends in parallel, deduplicate by chain ID
    const results = await Promise.allSettled(backends.map((b) => b.getSupportedChains()));
    const chainMap = new Map<number, { id: number; name: string; key: string; providers: string[] }>();

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const chain of result.value) {
        const existing = chainMap.get(chain.id);
        if (existing) {
          for (const p of chain.providers) {
            if (!existing.providers.includes(p)) existing.providers.push(p);
          }
        } else {
          chainMap.set(chain.id, {
            id: chain.id,
            name: chain.name,
            key: chain.key,
            providers: [...chain.providers],
          });
        }
      }
    }

    const chains = Array.from(chainMap.values()).sort((a, b) => a.id - b.id);
    const data = { chains, count: chains.length };
    chainsCache = { data, fetchedAt: now };
    return c.json(data);
  });

  return router;
}
