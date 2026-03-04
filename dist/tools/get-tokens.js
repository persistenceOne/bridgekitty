import { z } from "zod";
import { resolveChainId, getChainName, PERSISTENCE_CHAIN_ID, COSMOSHUB_CHAIN_ID } from "../utils/chains.js";
export function registerGetTokens(server, engine) {
    server.tool("bridge_tokens", "List popular tokens available for bridging on a given chain. " +
        "Returns verified token symbols, contract addresses, and decimals. " +
        "Supports EVM chains and Cosmos chains (Persistence, Cosmos Hub). " +
        "Use token symbols or addresses from this list in bridge_get_quote.", {
        chain: z.string().describe("Chain name or ID (e.g. 'base', '8453')"),
        search: z
            .string()
            .optional()
            .describe("Filter by token name or symbol"),
    }, async (params) => {
        const chainId = resolveChainId(params.chain);
        if (!chainId) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown chain: ${params.chain}. Use a chain name or ID.`,
                    },
                ],
            };
        }
        // Try backends in order until one returns tokens.
        // LI.FI has the widest EVM coverage; Squid covers Cosmos chains.
        const backends = engine.getAllBackends();
        for (const backend of backends) {
            if (!backend.getSupportedTokens)
                continue;
            try {
                let tokens = await backend.getSupportedTokens(chainId);
                if (!tokens || tokens.length === 0)
                    continue;
                if (params.search) {
                    const q = params.search.toLowerCase();
                    tokens = tokens.filter((t) => t.symbol.toLowerCase().includes(q) ||
                        t.name.toLowerCase().includes(q));
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                chain: getChainName(chainId),
                                chainId,
                                tokenCount: tokens.length,
                                tokens: tokens.slice(0, 30).map((t) => ({
                                    symbol: t.symbol,
                                    name: t.name,
                                    address: t.address,
                                    decimals: t.decimals,
                                })),
                            }, null, 2),
                        },
                    ],
                };
            }
            catch {
                // This backend failed — try the next one
                continue;
            }
        }
        // Hardcoded fallback for Persistence — Squid API may require auth
        if (chainId === PERSISTENCE_CHAIN_ID) {
            const persistenceTokens = [
                { symbol: "XPRT", name: "Persistence", address: "uxprt", decimals: 6 },
                { symbol: "stATOM", name: "Stride Staked ATOM", address: "ibc/C8A74ABBE2AF892E15680D916A7C22130585CE5704F9B17A10F184A90D53BECA", decimals: 6 },
                { symbol: "stkATOM", name: "pSTAKE Staked ATOM", address: "stk/uatom", decimals: 6 },
                { symbol: "ATOM", name: "Cosmos Hub", address: "ibc/C8A74ABBE2AF892E15680D916A7C22130585CE5704F9B17A10F184A90D53BECA", decimals: 6 },
                { symbol: "USDT", name: "Tether USD (Axelar)", address: "ibc/B56D6A6284B153D6F054485A9B78AD1FCE5699D751DA511262268105983B147C", decimals: 6 },
                { symbol: "USDC", name: "USD Coin (Axelar)", address: "ibc/68F4C3E20AF7CAAFBE5E9CBE6C5F2A186DB3766E7B19D9929B260BE58B76E164", decimals: 6 },
                { symbol: "WETH", name: "Wrapped ETH (Axelar)", address: "ibc/5F9BE030FC1EC5BF20E90B4A2F930D43DB54B860E3B2D4F0FB27E380E9B9359D", decimals: 18 },
                { symbol: "WBTC", name: "Wrapped BTC (Axelar)", address: "ibc/680BE60BFE5A303E5AB3B4E5B5F3CFAE5F9DE6927081B11D86DE8E2D364E9E6A", decimals: 8 },
            ];
            let filtered = persistenceTokens;
            if (params.search) {
                const q = params.search.toLowerCase();
                filtered = persistenceTokens.filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
            }
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            chain: getChainName(chainId),
                            chainId,
                            tokenCount: filtered.length,
                            tokens: filtered,
                            note: "Curated token list (live API unavailable)",
                        }, null, 2),
                    }],
            };
        }
        // Hardcoded fallback for Cosmos Hub
        if (chainId === COSMOSHUB_CHAIN_ID) {
            const cosmosTokens = [
                { symbol: "ATOM", name: "Cosmos Hub", address: "uatom", decimals: 6 },
                { symbol: "USDC", name: "USD Coin (Noble)", address: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA9E", decimals: 6 },
                { symbol: "stATOM", name: "Stride Staked ATOM", address: "ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17C5", decimals: 6 },
            ];
            let filtered = cosmosTokens;
            if (params.search) {
                const q = params.search.toLowerCase();
                filtered = cosmosTokens.filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
            }
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            chain: getChainName(chainId),
                            chainId,
                            tokenCount: filtered.length,
                            tokens: filtered,
                            note: "Curated token list (live API unavailable)",
                        }, null, 2),
                    }],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Could not fetch tokens for ${getChainName(chainId)}. Try using a token symbol (USDC, ETH) or contract address directly in bridge_get_quote.`,
                },
            ],
        };
    });
}
