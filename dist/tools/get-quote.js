import { z } from "zod";
import { resolveChainId, getChainName } from "../utils/chains.js";
import { resolveTokenAddress, parseTokenAmount } from "../utils/tokens.js";
export function registerGetQuote(server, engine) {
    server.tool("bridge_get_quote", "Get the best cross-chain bridge quote across multiple protocols (LI.FI, Persistence). Returns ranked options by output amount, speed, and fees.", {
        fromChain: z
            .string()
            .describe("Source chain (e.g. 'ethereum', 'base', 'arbitrum', or chain ID like '1', '8453')"),
        toChain: z.string().describe("Destination chain"),
        fromToken: z
            .string()
            .describe("Token to send (symbol like 'USDC', 'ETH' or contract address)"),
        toToken: z
            .string()
            .describe("Token to receive (symbol like 'USDC' or contract address)"),
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
    }, async (params) => {
        // Resolve chains
        const fromChainId = resolveChainId(params.fromChain);
        const toChainId = resolveChainId(params.toChain);
        if (!fromChainId)
            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown source chain: ${params.fromChain}. Use chain name (e.g. 'base') or ID (e.g. '8453').`,
                    },
                ],
            };
        if (!toChainId)
            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown destination chain: ${params.toChain}. Use chain name (e.g. 'arbitrum') or ID.`,
                    },
                ],
            };
        // Resolve tokens
        const fromTokenResolved = resolveTokenAddress(params.fromToken, fromChainId);
        const toTokenResolved = resolveTokenAddress(params.toToken, toChainId);
        const fromTokenAddress = fromTokenResolved?.address ?? params.fromToken;
        const toTokenAddress = toTokenResolved?.address ?? params.toToken;
        const decimals = fromTokenResolved?.decimals ?? 18;
        // Parse amount
        const amountRaw = parseTokenAmount(params.amount, decimals);
        const quotes = await engine.getQuotes({
            fromChainId,
            toChainId,
            fromTokenAddress,
            toTokenAddress,
            amountRaw,
            fromAddress: params.fromAddress,
            toAddress: params.toAddress,
            preference: params.preference,
        });
        if (quotes.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No bridge routes found for ${params.amount} ${params.fromToken} from ${getChainName(fromChainId)} to ${getChainName(toChainId)}. The route may not be supported, or all providers timed out.`,
                    },
                ],
            };
        }
        // Determine fastest and best-rate quotes
        const fastestTime = Math.min(...quotes.map((q) => q.estimatedTimeSeconds));
        let bestOutputRaw = quotes[0].outputAmountRaw;
        for (const q of quotes) {
            try {
                if (BigInt(q.outputAmountRaw) > BigInt(bestOutputRaw)) {
                    bestOutputRaw = q.outputAmountRaw;
                }
            }
            catch { }
        }
        function tagsFor(q) {
            const t = [];
            if (q.estimatedTimeSeconds === fastestTime)
                t.push("⚡ fastest");
            try {
                if (BigInt(q.outputAmountRaw) === BigInt(bestOutputRaw))
                    t.push("💰 best rate");
            }
            catch { }
            return t;
        }
        const best = quotes[0];
        const bestTags = tagsFor(best);
        const tagStr = bestTags.length > 0 ? " " + bestTags.map((t) => t.replace(/^(⚡|💰) .*/, "$1")).join("") : "";
        function formatQuote(q) {
            const base = {
                provider: q.provider,
                outputAmount: q.outputAmount,
                estimatedTimeSeconds: q.estimatedTimeSeconds,
                route: q.route,
                quoteId: q.quoteId,
                tags: tagsFor(q),
                fees: {
                    totalUsd: `$${q.estimatedFeeUsd.toFixed(2)}`,
                    breakdown: {
                        gasCost: `$${q.feeBreakdown.gasCostUsd.toFixed(2)}`,
                        protocolFee: `$${q.feeBreakdown.protocolFeeUsd.toFixed(2)}`,
                        integratorFee: q.feeBreakdown.integratorFeeUsd > 0
                            ? `$${q.feeBreakdown.integratorFeeUsd.toFixed(2)}${q.feeBreakdown.integratorFeePercent ? ` (${q.feeBreakdown.integratorFeePercent})` : ""}`
                            : "none",
                    },
                },
            };
            return base;
        }
        const integratorNote = best.feeBreakdown.integratorFeePercent
            ? `Includes ${best.feeBreakdown.integratorFeePercent} integrator fee. Configure via LIFI_FEE env var (0-0.04).`
            : undefined;
        const response = {
            bestQuote: formatQuote(best),
            alternatives: quotes.slice(1, 5).map(formatQuote),
            totalRoutesFound: quotes.length,
            summary: `Best: ${best.outputAmount} ${params.toToken} via ${best.provider}${tagStr} (fee: ~$${best.estimatedFeeUsd.toFixed(2)}, ETA: ${best.estimatedTimeSeconds}s). ${quotes.length > 1 ? `${quotes.length - 1} alternative(s) available.` : ""}`,
            ...(integratorNote ? { integratorFeeNote: integratorNote } : {}),
        };
        return {
            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
    });
}
