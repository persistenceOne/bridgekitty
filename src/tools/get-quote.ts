import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { resolveChainId, getChainName, isCosmosChain } from "../utils/chains.js";
import { resolveToken } from "../utils/token-registry.js";
import { parseTokenAmount } from "../utils/tokens.js";
import { BackendValidationError } from "../backends/types.js";
import { getProvider } from "../utils/gas-estimator.js";

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const NATIVE_TOKEN_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// ─── Rate Limiting ─────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // max requests per route per window

// Map of route key → array of request timestamps
const rateLimitMap = new Map<string, number[]>();
let rateLimitCheckCount = 0;

/**
 * Evict stale entries from the rate limit map to prevent unbounded growth.
 * (NEW-MEDIUM-002: periodic cleanup every 100 calls)
 */
function evictStaleRateLimitEntries(): void {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap) {
    const hasRecent = timestamps.some(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (!hasRecent) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(routeKey: string): boolean {
  const now = Date.now();

  // Periodic cleanup to bound memory (NEW-MEDIUM-002)
  rateLimitCheckCount++;
  if (rateLimitCheckCount % 100 === 0) {
    evictStaleRateLimitEntries();
  }

  const timestamps = rateLimitMap.get(routeKey) ?? [];
  // Prune expired entries
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitMap.set(routeKey, recent);
    return false; // rate limited
  }
  recent.push(now);
  rateLimitMap.set(routeKey, recent);
  return true; // allowed
}

export function registerGetQuote(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_get_quote",
    "Get the best cross-chain bridge quote across multiple providers (LI.FI, Squid Router, deBridge, Across, Relay, Persistence Interop). " +
    "Supports EVM chains, Cosmos chains (Persistence, Cosmos Hub), and Solana. " +
    "Accepts token symbols (e.g. 'USDC', 'ETH', 'WBTC', 'XPRT', 'ATOM') or contract addresses (0x...). " +
    "Symbols are resolved to verified canonical addresses only — no unverified tokens. " +
    "Returns ranked options by output amount, speed, and fees. Includes failedProviders array showing which providers didn't return quotes and why. " +
    "Preconditions: None for quoting. Use bridge_execute to act on a quote. " +
    "Error codes: 'Token resolution failed' (unknown symbol), 'Rate limited' (too many requests), 'Validation error' (invalid params).",
    {
      fromChain: z
        .string()
        .describe(
          "Source chain (e.g. 'ethereum', 'base', 'arbitrum', or chain ID like '1', '8453')"
        ),
      toChain: z.string().describe("Destination chain"),
      fromToken: z
        .string()
        .describe(
          "Token to send — symbol (e.g. 'USDC', 'ETH', 'WBTC') or contract address (0x...). " +
          "Symbols resolve to verified canonical addresses only."
        ),
      toToken: z
        .string()
        .describe(
          "Token to receive — symbol (e.g. 'USDC', 'ETH') or contract address (0x...). " +
          "Symbols resolve to verified canonical addresses only."
        ),
      amount: z
        .string()
        .describe("Amount in human-readable units (e.g. '100' for 100 USDC)"),
      fromAddress: z.string().describe("Sender wallet address (0x...)"),
      toAddress: z
        .string()
        .optional()
        .describe("Recipient address (defaults to fromAddress)"),
      preference: z
        .enum(["cheapest", "fastest"])
        .default("fastest")
        .describe("Optimize for lowest cost or fastest delivery"),
      providers: z
        .array(z.string())
        .optional()
        .describe("Optional: only query specific providers (e.g. ['squid', 'lifi']). Default: query all."),
    },
    async (params) => {
      // Resolve chains
      const fromChainId = resolveChainId(params.fromChain);
      const toChainId = resolveChainId(params.toChain);
      if (!fromChainId)
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown source chain: ${params.fromChain}. Use chain name (e.g. 'base') or ID (e.g. '8453').`,
            },
          ],
        };
      if (!toChainId)
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown destination chain: ${params.toChain}. Use chain name (e.g. 'arbitrum') or ID.`,
            },
          ],
        };

      // Rate limit check per route
      const routeKey = `${fromChainId}:${toChainId}:${params.fromToken.toLowerCase()}:${params.toToken.toLowerCase()}:${params.fromAddress.toLowerCase()}`;
      if (!checkRateLimit(routeKey)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Rate limited",
              message: `Too many requests for this route. Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per minute. Please wait and try again.`,
            }),
          }],
          isError: true,
        };
      }

      // Validate amount is positive before parsing
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
      const amountNum = Number(amountTrimmed);
      if (isNaN(amountNum) || amountNum <= 0) {
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

      // Pre-flight: warn if fromAddress is a zero address or burn address
      const ZERO_ADDRESSES = [
        "0x0000000000000000000000000000000000000000",
        "0x000000000000000000000000000000000000dead",
      ];
      if (ZERO_ADDRESSES.includes(params.fromAddress.toLowerCase())) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Invalid sender address",
              message: `The sender address ${params.fromAddress} appears to be a zero/burn address. Provide a real wallet address.`,
            }),
          }],
          isError: true,
        };
      }

      // Resolve tokens via verified registry
      const fromTokenResult = resolveToken(params.fromToken, fromChainId);
      if (!fromTokenResult.ok) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Token resolution failed",
              token: params.fromToken,
              chain: getChainName(fromChainId),
              chainId: fromChainId,
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
              chainId: toChainId,
              message: toTokenResult.error,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const fromTokenAddress = fromTokenResult.address;
      const toTokenAddress = toTokenResult.address;
      const decimals = fromTokenResult.decimals;
      const toDecimals = toTokenResult.decimals;
      const fromSymbol = fromTokenResult.symbol;
      const toSymbol = toTokenResult.symbol;

      // Parse amount to raw units
      const amountRaw = parseTokenAmount(amountTrimmed, decimals);

      let quotes: Awaited<ReturnType<typeof engine.getQuotes>>;
      try {
        quotes = await engine.getQuotes({
          fromChainId,
          toChainId,
          fromTokenAddress,
          toTokenAddress,
          amountRaw,
          fromAddress: params.fromAddress,
          toAddress: params.toAddress,
          preference: params.preference,
          fromTokenDecimals: decimals,
          toTokenDecimals: toDecimals,
          providers: params.providers,
        });
      } catch (err) {
        if (err instanceof BackendValidationError) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Validation error", message: err.message }),
            }],
            isError: true,
          };
        }
        throw err;
      }

      if (quotes.length === 0) {
        // Differentiate "route doesn't exist" from "backends are down"
        const diagnosis = engine.getLastRequestDiagnosis();
        let message: string;
        if (diagnosis.allErrored) {
          message = `All bridge providers are currently unavailable. Please try again in a few minutes.`;
          if (diagnosis.circuitBroken.length > 0) {
            message += ` (${diagnosis.circuitBroken.join(", ")} temporarily disabled due to repeated failures)`;
          }
        } else {
          message = `No bridge routes found for ${params.amount} ${fromSymbol} from ${getChainName(fromChainId)} to ${getChainName(toChainId)}. This route may not be supported by any provider.`;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: message,
            },
          ],
        };
      }

      const best = quotes[0];

      function formatTime(seconds: number): string {
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
      }

      // Backends where gas is estimated by us (not provided by the backend API)
      const GAS_ESTIMATED_BACKENDS = new Set(["debridge", "across", "persistence"]);

      // Compute stats for tags
      const fastestTime = Math.min(...quotes.map(q => q.estimatedTimeSeconds));
      let bestOutputRaw = "0";
      for (const q of quotes) {
        try {
          if (BigInt(q.minOutputAmountRaw) > BigInt(bestOutputRaw)) {
            bestOutputRaw = q.minOutputAmountRaw;
          }
        } catch { /* skip */ }
      }

      function formatGasFee(q: typeof quotes[number]): string {
        // If gas cost is null/unknown, display "unknown" — never show misleading $0.00
        if (q.estimatedGasCostUsd === null || q.estimatedGasCostUsd === undefined) {
          return "unknown";
        }
        if (q.estimatedGasCostUsd > 0) {
          // Backends where we estimate gas ourselves get the "~" and "(est)" markers
          if (GAS_ESTIMATED_BACKENDS.has(q.backendName)) {
            return `~$${q.estimatedGasCostUsd.toFixed(2)} (est)`;
          }
          return `$${q.estimatedGasCostUsd.toFixed(2)}`;
        }
        return "$0.00";
      }

      function buildTags(q: typeof quotes[number]): string[] {
        const tags: string[] = [];
        if (quotes.length > 1) {
          if (q.estimatedTimeSeconds === fastestTime) {
            tags.push("⚡ fastest");
          }
          try {
            if (BigInt(q.minOutputAmountRaw) === BigInt(bestOutputRaw)) {
              tags.push("💰 best rate");
            }
          } catch { /* skip */ }
        }
        return tags;
      }

      function formatQuote(q: typeof quotes[number]) {
        const expiresInSeconds = q.expiresAt
          ? Math.max(0, Math.round((q.expiresAt - Date.now()) / 1000))
          : null;
        return {
          provider: q.provider,
          youReceiveMin: `${q.minOutputAmount} ${toSymbol}`,
          estimatedGasFee: formatGasFee(q),
          estimatedTime: formatTime(q.estimatedTimeSeconds),
          route: q.route,
          tags: buildTags(q),
          quoteId: q.quoteId,
          expiresAt: q.expiresAt ? new Date(q.expiresAt).toISOString() : null,
          expiresInSeconds,
        };
      }

      const bestGasDisplay = formatGasFee(best);

      // Include failed providers for transparency
      const failedProviders = engine.getLastFailedProviders();

      const response: Record<string, any> = {
        bestQuote: formatQuote(best),
        alternatives: quotes.slice(1, 5).map(formatQuote),
        totalRoutesFound: quotes.length,
        summary: `Best: receive min ${best.minOutputAmount} ${toSymbol} via ${best.provider} (gas: ${bestGasDisplay}, ETA: ${formatTime(best.estimatedTimeSeconds)}). ${quotes.length > 1 ? `${quotes.length - 1} alternative(s) available.` : ""}`,
      };

      if (failedProviders.length > 0) {
        response.failedProviders = failedProviders;
      }

      // Pre-flight balance warning: check if wallet has enough funds for the quote
      if (params.fromAddress && !isCosmosChain(fromChainId)) {
        try {
          const isNative =
            fromTokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase() ||
            fromTokenAddress === "0x0000000000000000000000000000000000000000";

          const provider = await getProvider(fromChainId);
          let walletBalance: bigint;
          let balanceFormatted: string;

          if (isNative) {
            walletBalance = await provider.getBalance(params.fromAddress);
            balanceFormatted = ethers.formatEther(walletBalance);
          } else {
            const contract = new ethers.Contract(fromTokenAddress, ERC20_BALANCE_ABI, provider);
            walletBalance = await contract.balanceOf(params.fromAddress);
            balanceFormatted = ethers.formatUnits(walletBalance, decimals);
          }

          const amountRequired = BigInt(amountRaw);
          if (walletBalance < amountRequired) {
            response.balanceWarning = `Warning: wallet balance (${balanceFormatted} ${fromSymbol}) may be insufficient for ${params.amount} ${fromSymbol} quote`;
          }
        } catch {
          // Balance check failure should never block the quote
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
