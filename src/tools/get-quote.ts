import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { resolveChainId, getChainName, isCosmosChain, isSolanaChain, SOLANA_CHAIN_ID } from "../utils/chains.js";
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
      fromAddress: z.string().describe("Sender wallet address (0x... for EVM, base58 for Solana)"),
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
      // Helper: resolve toAddress for non-EVM destinations (Solana, Cosmos)
      async function resolveToAddress(toAddress: string | undefined, destChainId: number): Promise<string | undefined> {
        if (toAddress) return toAddress;
        if (!isSolanaChain(destChainId)) return undefined;
        // Auto-derive Solana address from wallet's Solana key
        try {
          const { getKey } = await import("./wallet.js");
          const solanaKey = getKey("solanaKey");
          if (solanaKey) {
            const bs58 = await import("bs58");
            const { Keypair } = await import("@solana/web3.js");
            const secretKey = bs58.default.decode(solanaKey);
            const keypair = Keypair.fromSecretKey(secretKey);
            return keypair.publicKey.toBase58();
          }
          // Fall back to mnemonic-derived address
          const mnemonic = getKey("mnemonic");
          if (mnemonic) {
            const { derivePath } = await import("ed25519-hd-key") as any;
            const bip39 = await import("@scure/bip39") as any;
            const { Keypair } = await import("@solana/web3.js");
            const seed = await bip39.mnemonicToSeed(mnemonic);
            const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString("hex")).key;
            const keypair = Keypair.fromSeed(derivedSeed);
            return keypair.publicKey.toBase58();
          }
        } catch {
          // Non-fatal — Solana key derivation failed, quote will still work without toAddress
        }
        return undefined;
      }

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
          toAddress: await resolveToAddress(params.toAddress, toChainId),
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

      // Stamp human-readable swap context on each cached quote so bridge_execute
      // can report a completed swap to the backend for analytics (source=npm)
      // without having to reverse-map backend-specific quoteData.
      const swapContext = {
        fromChain: getChainName(fromChainId),
        toChain: getChainName(toChainId),
        fromTokenSymbol: fromSymbol,
        toTokenSymbol: toSymbol,
        amount: amountTrimmed,
        fromAddress: params.fromAddress,
      };
      for (const q of quotes) {
        (q as typeof q & { swapContext?: typeof swapContext }).swapContext = swapContext;
      }

      if (quotes.length === 0) {
        // Differentiate "route doesn't exist" from "backends are down"
        const diagnosis = engine.getLastRequestDiagnosis();
        const failedProviders = engine.getLastFailedProviders();
        let message: string;
        if (diagnosis.allErrored) {
          message = `All bridge providers are currently unavailable. Please try again in a few minutes.`;
          if (diagnosis.circuitBroken.length > 0) {
            message += ` (${diagnosis.circuitBroken.join(", ")} temporarily disabled due to repeated failures)`;
          }
        } else {
          message = `No bridge routes found for ${params.amount} ${fromSymbol} from ${getChainName(fromChainId)} to ${getChainName(toChainId)}. This route may not be supported by any provider.`;
        }
        // Surface per-provider failure reasons so callers can diagnose without
        // having to enable verbose logging on the hosted backend.
        if (failedProviders.length > 0) {
          const lines = failedProviders.map((f) => `  - ${f.provider}: ${f.reason}`);
          message += `\n\nProvider details:\n${lines.join("\n")}`;
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
          // For very small but non-zero amounts, show "<$0.01" instead of "$0.00"
          if (q.estimatedGasCostUsd < 0.01) {
            const marker = GAS_ESTIMATED_BACKENDS.has(q.backendName) ? "~" : "";
            return `${marker}<$0.01`;
          }
          // Backends where we estimate gas ourselves get the "~" and "(est)" markers
          if (GAS_ESTIMATED_BACKENDS.has(q.backendName)) {
            return `~$${q.estimatedGasCostUsd.toFixed(2)} (est)`;
          }
          return `$${q.estimatedGasCostUsd.toFixed(2)}`;
        }
        return "$0.00";
      }

      function getFeeModel(q: typeof quotes[number]): string {
        switch (q.backendName) {
          case "relay":
            return "gas_included_in_spread";
          case "persistence":
            return "gasless_relay";
          case "lifi":
          case "squid":
          case "debridge":
          case "across":
          default:
            return "user_pays_gas";
        }
      }

      // L2 chains with typically very low gas costs
      const L2_CHAINS = new Set([
        10, 137, 324, 8453, 42161, 42170, 59144, 534352, 1101, 81457, 7777777,
        34443, 204, 1088, 5000, 288, 252, 690, 1135, 1329, 1868, 1923, 2741,
        7560, 13371, 33139, 167000, 60808, 1750, 2522, 232, 999, 360, 1514,
        810180, 4326, 9745
      ]);

      function getGasEstimateNote(chainId: number): string | null {
        if (L2_CHAINS.has(chainId)) {
          const chainName = getChainName(chainId);
          return `Gas on ${chainName} L2 is typically <$0.01`;
        }
        return null;
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
        const gasNote = fromChainId ? getGasEstimateNote(fromChainId) : null;
        const quote: any = {
          provider: q.provider,
          youReceiveMin: `${q.minOutputAmount} ${toSymbol}`,
          estimatedGasFee: formatGasFee(q),
          feeModel: getFeeModel(q),
          estimatedTime: formatTime(q.estimatedTimeSeconds),
          route: q.route,
          tags: buildTags(q),
          quoteId: q.quoteId,
          expiresAt: q.expiresAt ? new Date(q.expiresAt).toISOString() : null,
          expiresInSeconds,
        };
        if (gasNote) {
          quote.gasEstimateNote = gasNote;
        }

        // Surface protocol fees (deBridge fixFee, operating expenses) so agents know the REAL cost
        const fb = q.feeBreakdown as any;
        if (fb?.fixFeeNativeRaw && fb.fixFeeNativeRaw !== "0") {
          const fixFeeEth = Number(BigInt(fb.fixFeeNativeRaw)) / 1e18;
          const cid = fromChainId!;
          const nativeSymbol = [56].includes(cid) ? "BNB"
            : [137].includes(cid) ? "MATIC"
            : [43114].includes(cid) ? "AVAX"
            : "ETH";
          quote.protocolFee = `${fixFeeEth.toFixed(6)} ${nativeSymbol}`;
          // Total the user actually pays (input + fees), formatted
          if (fb.totalSourceAmountRaw) {
            const totalSrc = Number(BigInt(fb.totalSourceAmountRaw)) / (10 ** decimals);
            quote.totalSourceCost = `${totalSrc} ${fromSymbol} + ${fixFeeEth.toFixed(6)} ${nativeSymbol} protocol fee`;
          }
          // Warn when protocol fee exceeds bridge amount
          try {
            const fixFeeBig = BigInt(fb.fixFeeNativeRaw);
            const amountBig = BigInt(amountRaw);
            // Only compare when both are in the same denomination (native token)
            if (fromTokenAddress === "0x0000000000000000000000000000000000000000" ||
                fromTokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
              if (fixFeeBig > amountBig) {
                quote.feeWarning = `⚠️ Protocol fee (${fixFeeEth.toFixed(6)} ${nativeSymbol}) exceeds bridge amount (${params.amount} ${fromSymbol}). Consider bridging a larger amount.`;
              }
            }
          } catch { /* ignore */ }
        }

        return quote;
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
      // Solana balance check
      if (params.fromAddress && isSolanaChain(fromChainId)) {
        try {
          const { Connection, PublicKey } = await import("@solana/web3.js");
          const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
          const pubkey = new PublicKey(params.fromAddress);
          const isNativeSOL = fromTokenAddress === "So11111111111111111111111111111111111111112";

          let walletBalance: bigint;
          let balanceFormatted: string;

          if (isNativeSOL) {
            const lamports = await connection.getBalance(pubkey);
            walletBalance = BigInt(lamports);
            balanceFormatted = (lamports / 1e9).toFixed(6);
          } else {
            // SPL token balance
            const tokenMint = new PublicKey(fromTokenAddress);
            const accounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: tokenMint });
            const totalAmount = accounts.value.reduce((sum: bigint, acc: any) => {
              return sum + BigInt(acc.account.data.parsed.info.tokenAmount.amount);
            }, 0n);
            walletBalance = totalAmount;
            balanceFormatted = (Number(totalAmount) / 10 ** decimals).toFixed(decimals);
          }

          const amountRequired = BigInt(amountRaw);
          if (walletBalance < amountRequired) {
            response.balanceWarning = `Warning: wallet balance (${balanceFormatted} ${fromSymbol}) may be insufficient for ${params.amount} ${fromSymbol} quote`;
          }
        } catch {
          // Balance check failure should never block the quote
        }
      }

      // EVM balance check — validates BOTH token balance AND native balance for protocol fees
      if (params.fromAddress && !isCosmosChain(fromChainId) && !isSolanaChain(fromChainId)) {
        try {
          const isNative =
            fromTokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase() ||
            fromTokenAddress === "0x0000000000000000000000000000000000000000";

          const provider = await getProvider(fromChainId);

          // Always check native balance (needed for gas + protocol fees even for ERC-20 bridges)
          const nativeBalance = await provider.getBalance(params.fromAddress);

          if (isNative) {
            // For native token bridges: total cost = bridge amount + protocol fee + operating expenses
            const bestFb = best.feeBreakdown as any;
            const fixFee = bestFb?.fixFeeNativeRaw ? BigInt(bestFb.fixFeeNativeRaw) : 0n;
            const totalSourceRaw = bestFb?.totalSourceAmountRaw ? BigInt(bestFb.totalSourceAmountRaw) : BigInt(amountRaw);
            // Total needed = totalSourceAmount (amount + operating expenses) + fixFee
            const totalNeeded = totalSourceRaw + fixFee;

            const balanceFormatted = ethers.formatEther(nativeBalance);
            const nativeSymbol = [56].includes(fromChainId) ? "BNB"
              : [137].includes(fromChainId) ? "MATIC"
              : [43114].includes(fromChainId) ? "AVAX"
              : "ETH";

            if (nativeBalance < totalNeeded) {
              const totalNeededFormatted = ethers.formatEther(totalNeeded);
              response.balanceWarning = `⚠️ Insufficient balance: wallet has ${balanceFormatted} ${nativeSymbol}, but this bridge requires ~${totalNeededFormatted} ${nativeSymbol} total (${params.amount} ${fromSymbol} bridge amount + protocol fees + operating expenses)`;
            }
          } else {
            // For ERC-20 bridges: check token balance AND native balance for protocol fees + gas
            const contract = new ethers.Contract(fromTokenAddress, ERC20_BALANCE_ABI, provider);
            const tokenBalance: bigint = await contract.balanceOf(params.fromAddress);
            const tokenFormatted = ethers.formatUnits(tokenBalance, decimals);

            const amountRequired = BigInt(amountRaw);
            const warnings: string[] = [];

            if (tokenBalance < amountRequired) {
              warnings.push(`Token balance (${tokenFormatted} ${fromSymbol}) is insufficient for ${params.amount} ${fromSymbol}`);
            }

            // Check native balance for protocol fee
            const bestFb = best.feeBreakdown as any;
            const fixFee = bestFb?.fixFeeNativeRaw ? BigInt(bestFb.fixFeeNativeRaw) : 0n;
            if (fixFee > 0n) {
              const nativeSymbol = [56].includes(fromChainId) ? "BNB"
                : [137].includes(fromChainId) ? "MATIC"
                : [43114].includes(fromChainId) ? "AVAX"
                : "ETH";
              // Need fixFee + some gas (estimate ~0.0002 ETH for L2s)
              const gasBuffer = fromChainId === 1 ? 2000000000000000n : 200000000000000n; // 0.002 ETH L1 / 0.0002 ETH L2
              const totalNativeNeeded = fixFee + gasBuffer;

              if (nativeBalance < totalNativeNeeded) {
                const nativeFormatted = ethers.formatEther(nativeBalance);
                const feeFormatted = ethers.formatEther(fixFee);
                warnings.push(`Native balance (${nativeFormatted} ${nativeSymbol}) may be insufficient for protocol fee (${feeFormatted} ${nativeSymbol}) + gas`);
              }
            }

            if (warnings.length > 0) {
              response.balanceWarning = `⚠️ ${warnings.join(". ")}`;
            }
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
