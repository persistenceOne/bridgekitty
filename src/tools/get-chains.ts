import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import type { ChainInfo } from "../backends/types.js";

export function registerGetChains(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_chains",
    "List all supported chains for cross-chain bridging, including which providers support each chain.",
    {},
    async () => {
      const chainMap = new Map<number, ChainInfo>();

      const results = await Promise.allSettled(
        engine.getAllBackends().map((b) => b.getSupportedChains())
      );

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const chain of result.value) {
          const existing = chainMap.get(chain.id);
          if (existing) {
            // Merge providers
            for (const p of chain.providers) {
              if (!existing.providers.includes(p)) existing.providers.push(p);
            }
          } else {
            chainMap.set(chain.id, { ...chain });
          }
        }
      }

      const chains = Array.from(chainMap.values()).sort((a, b) => a.id - b.id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                totalChains: chains.length,
                chains: chains.map((c) => ({
                  id: c.id,
                  name: c.name,
                  key: c.key,
                  providers: c.providers,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
