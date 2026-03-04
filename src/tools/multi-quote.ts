import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { resolveChainId, getChainName } from "../utils/chains.js";
import { resolveToken } from "../utils/token-registry.js";
import { parseTokenAmount } from "../utils/tokens.js";

// Common intermediary tokens used for multi-hop routing
const INTERMEDIARIES: Array<{ symbol: string; label: string }> = [
  { symbol: "USDC", label: "USDC" },
  { symbol: "ETH", label: "ETH" },
  { symbol: "CBBTC", label: "cbBTC" },
  { symbol: "WBTC", label: "WBTC" },
];

interface HopDetail {
  hopNumber: number;
  provider: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  estimatedOutput: string;
  estimatedFeeUsd: number | null;
  estimatedTimeSeconds: number;
}

interface MultiHopRoute {
  hops: HopDetail[];
  estimatedOutput: string;
  totalFeeUsd: number | null;
  estimatedTotalTimeSeconds: string;
  routeLabel: string;
}

export function registerMultiQuote(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_quote_multi",
    "Get quotes for multi-hop routes across supported EVM chains. Resolves optimal path internally " +
    "-- e.g., ETH on Base to USDC on Arbitrum may route through WBTC. Returns the full route " +
    "as ordered hops with per-hop detail. " +
    "Note: For Cosmos destinations (Persistence, Cosmos Hub), use xprt_farm_boost or bridge_get_quote with Squid Router.",
    {
      fromChain: z
        .string()
        .describe("Source chain (e.g. 'base', 'ethereum', or chain ID like '8453')"),
      fromToken: z
        .string()
        .describe("Token to send -- symbol (e.g. 'USDC', 'ETH') or contract address (0x...)"),
      toChain: z
        .string()
        .describe("Destination chain (e.g. 'arbitrum', 'bsc', or chain ID)"),
      toToken: z
        .string()
        .describe("Token to receive -- symbol (e.g. 'USDC', 'ETH') or contract address (0x...)"),
      amount: z
        .string()
        .describe("Amount in human-readable units (e.g. '100' for 100 USDC)"),
      fromAddress: z
        .string()
        .describe("Sender wallet address (0x...)"),
      optimize: z
        .enum(["cheapest", "fastest"])
        .default("cheapest")
        .describe("Optimize for lowest cost or fastest delivery"),
    },
    async (params) => {
      // Resolve chains
      const fromChainId = resolveChainId(params.fromChain);
      const toChainId = resolveChainId(params.toChain);

      if (!fromChainId) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown source chain: ${params.fromChain}. Use chain name (e.g. 'base') or ID (e.g. '8453').`,
          }],
          isError: true,
        };
      }
      if (!toChainId) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown destination chain: ${params.toChain}. Use chain name (e.g. 'arbitrum') or ID.`,
          }],
          isError: true,
        };
      }

      // Resolve tokens
      const fromTokenResult = resolveToken(params.fromToken, fromChainId);
      if (!fromTokenResult.ok) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Token resolution failed",
              token: params.fromToken,
              chain: getChainName(fromChainId),
              message: fromTokenResult.error,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const toTokenResult = resolveToken(params.toToken, toChainId);
      if (!toTokenResult.ok) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Token resolution failed",
              token: params.toToken,
              chain: getChainName(toChainId),
              message: toTokenResult.error,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const fromTokenAddress = fromTokenResult.address;
      const toTokenAddress = toTokenResult.address;
      const fromDecimals = fromTokenResult.decimals;
      const toDecimals = toTokenResult.decimals;
      const fromSymbol = fromTokenResult.symbol;
      const toSymbol = toTokenResult.symbol;

      // Validate amount
      const amountTrimmed = params.amount.trim();
      if (!amountTrimmed || !/^\d+\.?\d*$/.test(amountTrimmed)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Invalid amount",
              message: `Amount must be a positive number. Got: "${params.amount}"`,
            }),
          }],
          isError: true,
        };
      }

      const amountRaw = parseTokenAmount(amountTrimmed, fromDecimals);
      const routes: MultiHopRoute[] = [];

      // ── Strategy 1: Try direct route ────────────────────────────────────────
      try {
        const directQuotes = await engine.getQuotes({
          fromChainId,
          toChainId,
          fromTokenAddress,
          toTokenAddress,
          amountRaw,
          fromAddress: params.fromAddress,
          preference: params.optimize,
          fromTokenDecimals: fromDecimals,
          toTokenDecimals: toDecimals,
        });

        for (const q of directQuotes.slice(0, 2)) {
          routes.push({
            hops: [{
              hopNumber: 1,
              provider: q.provider,
              fromChain: getChainName(fromChainId),
              toChain: getChainName(toChainId),
              fromToken: fromSymbol,
              toToken: toSymbol,
              estimatedOutput: q.minOutputAmount,
              estimatedFeeUsd: q.estimatedFeeUsd,
              estimatedTimeSeconds: q.estimatedTimeSeconds,
            }],
            estimatedOutput: `${q.minOutputAmount} ${toSymbol}`,
            totalFeeUsd: q.estimatedFeeUsd,
            estimatedTotalTimeSeconds: `${q.estimatedTimeSeconds}s`,
            routeLabel: `Direct: ${fromSymbol} -> ${toSymbol} via ${q.provider}`,
          });
        }
      } catch {
        // Direct route failed -- continue to multi-hop
      }

      // ── Strategy 2: Try 2-hop routes via intermediaries ─────────────────────
      if (routes.length < 3) {
        const intermediaryPromises = INTERMEDIARIES
          .filter((mid) => {
            // Skip if intermediary is the same as source or destination token
            return mid.symbol.toUpperCase() !== fromSymbol.toUpperCase() &&
                   mid.symbol.toUpperCase() !== toSymbol.toUpperCase();
          })
          .map(async (mid) => {
            try {
              // Resolve intermediary on source chain (for hop 1 destination)
              const midOnSourceResult = resolveToken(mid.symbol, fromChainId);
              if (!midOnSourceResult.ok) return null;

              // Resolve intermediary on destination chain (for hop 2 source)
              const midOnDestResult = resolveToken(mid.symbol, toChainId);
              if (!midOnDestResult.ok) return null;

              // Hop 1: fromToken on fromChain -> intermediary on fromChain (same-chain swap)
              // Then cross-chain: intermediary fromChain -> intermediary toChain
              // For simplicity, try direct cross-chain: fromToken -> intermediary on toChain
              // Then intermediary -> toToken on toChain

              // Hop 1: fromToken -> midToken cross-chain (fromChain -> toChain)
              let hop1Quotes;
              try {
                hop1Quotes = await engine.getQuotes({
                  fromChainId,
                  toChainId,
                  fromTokenAddress,
                  toTokenAddress: midOnDestResult.address,
                  amountRaw,
                  fromAddress: params.fromAddress,
                  preference: params.optimize,
                  fromTokenDecimals: fromDecimals,
                  toTokenDecimals: midOnDestResult.decimals,
                });
              } catch {
                return null;
              }

              if (!hop1Quotes || hop1Quotes.length === 0) return null;
              const hop1 = hop1Quotes[0];

              // Hop 2: midToken -> toToken on toChain (same-chain swap)
              const hop1OutputRaw = hop1.minOutputAmountRaw;
              let hop2Quotes;
              try {
                hop2Quotes = await engine.getQuotes({
                  fromChainId: toChainId,
                  toChainId: toChainId,
                  fromTokenAddress: midOnDestResult.address,
                  toTokenAddress,
                  amountRaw: hop1OutputRaw,
                  fromAddress: params.fromAddress,
                  preference: params.optimize,
                  fromTokenDecimals: midOnDestResult.decimals,
                  toTokenDecimals: toDecimals,
                });
              } catch {
                // Same-chain swap may not be supported by cross-chain engine
                return null;
              }

              if (!hop2Quotes || hop2Quotes.length === 0) return null;
              const hop2 = hop2Quotes[0];

              const totalTimeSec = hop1.estimatedTimeSeconds + hop2.estimatedTimeSeconds;
              const fee1 = hop1.estimatedFeeUsd;
              const fee2 = hop2.estimatedFeeUsd;
              const totalFeeUsd = (fee1 !== null && fee2 !== null) ? fee1 + fee2 : null;

              return {
                hops: [
                  {
                    hopNumber: 1,
                    provider: hop1.provider,
                    fromChain: getChainName(fromChainId),
                    toChain: getChainName(toChainId),
                    fromToken: fromSymbol,
                    toToken: mid.label,
                    estimatedOutput: hop1.minOutputAmount,
                    estimatedFeeUsd: hop1.estimatedFeeUsd,
                    estimatedTimeSeconds: hop1.estimatedTimeSeconds,
                  },
                  {
                    hopNumber: 2,
                    provider: hop2.provider,
                    fromChain: getChainName(toChainId),
                    toChain: getChainName(toChainId),
                    fromToken: mid.label,
                    toToken: toSymbol,
                    estimatedOutput: hop2.minOutputAmount,
                    estimatedFeeUsd: hop2.estimatedFeeUsd,
                    estimatedTimeSeconds: hop2.estimatedTimeSeconds,
                  },
                ],
                estimatedOutput: `${hop2.minOutputAmount} ${toSymbol}`,
                totalFeeUsd,
                estimatedTotalTimeSeconds: `${totalTimeSec}s`,
                routeLabel: `${fromSymbol} -> ${mid.label} -> ${toSymbol} via ${hop1.provider} + ${hop2.provider}`,
              } as MultiHopRoute;
            } catch {
              return null;
            }
          });

        const intermediaryResults = await Promise.allSettled(intermediaryPromises);

        for (const result of intermediaryResults) {
          if (result.status === "fulfilled" && result.value) {
            routes.push(result.value);
          }
        }
      }

      if (routes.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "No routes found",
              message: `No direct or multi-hop routes found for ${params.amount} ${fromSymbol} from ${getChainName(fromChainId)} to ${toSymbol} on ${getChainName(toChainId)}. This route may not be supported.`,
              suggestions: [
                "Try different token pairs (e.g. bridge to USDC first, then swap).",
                "Check bridge_chains and bridge_tokens for supported chains/tokens.",
                "Use bridge_get_quote for direct single-hop routes.",
              ],
            }, null, 2),
          }],
        };
      }

      // Sort routes by optimization preference
      if (params.optimize === "cheapest") {
        routes.sort((a, b) => {
          // Parse output amounts for comparison (higher is better)
          const outA = parseFloat(a.estimatedOutput) || 0;
          const outB = parseFloat(b.estimatedOutput) || 0;
          return outB - outA;
        });
      } else {
        routes.sort((a, b) => {
          const timeA = parseInt(a.estimatedTotalTimeSeconds) || 0;
          const timeB = parseInt(b.estimatedTotalTimeSeconds) || 0;
          return timeA - timeB;
        });
      }

      // Limit to top 3
      const topRoutes = routes.slice(0, 3);

      const response = {
        routes: topRoutes,
        totalRoutesFound: routes.length,
        optimizedFor: params.optimize,
        summary: `Found ${routes.length} route(s) for ${params.amount} ${fromSymbol} (${getChainName(fromChainId)}) -> ${toSymbol} (${getChainName(toChainId)}). Best: ${topRoutes[0].routeLabel}, output: ${topRoutes[0].estimatedOutput}.`,
        note: "Multi-hop routes require executing each hop sequentially. Use bridge_get_quote + bridge_execute for each hop.",
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        }],
      };
    }
  );
}
