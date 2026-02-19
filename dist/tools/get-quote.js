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
            .default("cheapest")
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
        const best = quotes[0];
        const response = {
            bestQuote: {
                provider: best.provider,
                outputAmount: best.outputAmount,
                estimatedFeeUsd: best.estimatedFeeUsd,
                estimatedTimeSeconds: best.estimatedTimeSeconds,
                route: best.route,
                quoteId: best._cacheKey,
            },
            alternatives: quotes.slice(1, 3).map((q) => ({
                provider: q.provider,
                outputAmount: q.outputAmount,
                estimatedFeeUsd: q.estimatedFeeUsd,
                estimatedTimeSeconds: q.estimatedTimeSeconds,
                route: q.route,
                quoteId: q._cacheKey,
            })),
            summary: `Best: ${best.outputAmount} ${params.toToken} via ${best.provider} (fee: ~$${best.estimatedFeeUsd.toFixed(2)}, ETA: ${best.estimatedTimeSeconds}s). ${quotes.length > 1 ? `${quotes.length - 1} alternative(s) available.` : ""}`,
        };
        return {
            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
    });
}
