import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { resolveChainId, getChainName } from "../utils/chains.js";

export function registerGetTokens(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_tokens",
    "List popular tokens available for bridging on a given chain.",
    {
      chain: z.string().describe("Chain name or ID (e.g. 'base', '8453')"),
      search: z
        .string()
        .optional()
        .describe("Filter by token name or symbol"),
    },
    async (params) => {
      const chainId = resolveChainId(params.chain);
      if (!chainId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown chain: ${params.chain}. Use a chain name or ID.`,
            },
          ],
        };
      }

      // Try LI.FI first for comprehensive token list
      const lifi = engine.getBackend("lifi");
      if (lifi?.getSupportedTokens) {
        try {
          let tokens = await lifi.getSupportedTokens(chainId);
          if (params.search) {
            const q = params.search.toLowerCase();
            tokens = tokens.filter(
              (t) =>
                t.symbol.toLowerCase().includes(q) ||
                t.name.toLowerCase().includes(q)
            );
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    chain: getChainName(chainId),
                    chainId,
                    tokenCount: tokens.length,
                    tokens: tokens.slice(0, 30).map((t) => ({
                      symbol: t.symbol,
                      name: t.name,
                      address: t.address,
                      decimals: t.decimals,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch {
          // Fall through
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Could not fetch tokens for ${getChainName(chainId)}. Try using a token symbol (USDC, ETH) or contract address directly in bridge_get_quote.`,
          },
        ],
      };
    }
  );
}
