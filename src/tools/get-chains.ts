import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import type { ChainInfo } from "../backends/types.js";
import { isCosmosChain } from "../utils/chains.js";

// Well-known chain ID → canonical name/key (for resolving unnamed "Chain XXXX" entries
// and for picking the best name/key when merging duplicate entries from different providers)
const CHAIN_ID_NAMES: Record<number, { name: string; key: string }> = {
  1: { name: "Ethereum", key: "ethereum" },
  10: { name: "Optimism", key: "optimism" },
  14: { name: "Flare", key: "flare" },
  25: { name: "Cronos", key: "cronos" },
  30: { name: "Rootstock", key: "rootstock" },
  56: { name: "BNB Chain", key: "bsc" },
  100: { name: "Gnosis", key: "gnosis" },
  122: { name: "Fuse", key: "fuse" },
  130: { name: "Unichain", key: "unichain" },
  137: { name: "Polygon", key: "polygon" },
  143: { name: "Monad", key: "monad" },
  146: { name: "Sonic", key: "sonic" },
  196: { name: "X Layer", key: "xlayer" },
  204: { name: "opBNB", key: "opbnb" },
  232: { name: "Lens", key: "lens" },
  250: { name: "Fantom", key: "fantom" },
  252: { name: "Fraxtal", key: "fraxtal" },
  288: { name: "Boba", key: "boba" },
  324: { name: "zkSync Era", key: "zksync" },
  360: { name: "Shape", key: "shape" },
  480: { name: "World Chain", key: "world-chain" },
  690: { name: "Redstone", key: "redstone" },
  999: { name: "HyperEVM", key: "hyperevm" },
  1088: { name: "Metis", key: "metis" },
  1101: { name: "Polygon zkEVM", key: "polygon-zkevm" },
  1135: { name: "Lisk", key: "lisk" },
  1284: { name: "Moonbeam", key: "moonbeam" },
  1329: { name: "Sei", key: "sei" },
  1514: { name: "Hemi", key: "hemi" },
  1516: { name: "Story", key: "story" },
  1625: { name: "Gravity", key: "gravity" },
  1750: { name: "Metal L2", key: "metal" },
  1868: { name: "Soneium", key: "soneium" },
  1923: { name: "Swellchain", key: "swellchain" },
  2020: { name: "Ronin", key: "ronin" },
  2522: { name: "Shadow", key: "shadow" },
  2741: { name: "Abstract", key: "abstract" },
  5000: { name: "Mantle", key: "mantle" },
  7560: { name: "Cyber", key: "cyber" },
  7777777: { name: "Zora", key: "zora" },
  8217: { name: "Kaia", key: "kaia" },
  8453: { name: "Base", key: "base" },
  13371: { name: "Immutable zkEVM", key: "immutable-zkevm" },
  21000000: { name: "Corn", key: "corn" },
  33139: { name: "ApeChain", key: "apechain" },
  34443: { name: "Mode", key: "mode" },
  42161: { name: "Arbitrum", key: "arbitrum" },
  42170: { name: "Arbitrum Nova", key: "arbitrum-nova" },
  42220: { name: "Celo", key: "celo" },
  43114: { name: "Avalanche", key: "avalanche" },
  50104: { name: "Sophon", key: "sophon" },
  57073: { name: "Ink", key: "ink" },
  59144: { name: "Linea", key: "linea" },
  60808: { name: "Bob", key: "bob" },
  80094: { name: "Berachain", key: "berachain" },
  81457: { name: "Blast", key: "blast" },
  98865: { name: "Plume", key: "plume" },
  167000: { name: "Taiko", key: "taiko" },
  534352: { name: "Scroll", key: "scroll" },
  810180: { name: "zkLink Nova", key: "zklink-nova" },
  666666666: { name: "Degen", key: "degen" },
  7225878: { name: "Saakuru", key: "saakuru" },
  4326: { name: "MegaETH", key: "megaeth" },
  9745: { name: "Plasma", key: "plasma" },
  37714555429: { name: "Xai", key: "xai" },
};

export function registerGetChains(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_chains",
    "List supported chains for cross-chain bridging. " +
    "Shows which providers support each chain. " +
    "Chains are deduplicated and grouped by ecosystem: EVM, Cosmos, and Solana. " +
    "Use 'search' parameter to filter by chain name. Use this to discover available routes before calling bridge_get_quote.",
    {
      search: z.string().optional().describe("Filter chains by name (e.g. 'base', 'arb')"),
    },
    async (params) => {
      // Deduplicate by chain ID — different providers return different keys for the same chain
      // (e.g. LI.FI uses "bas", Across uses "chain-8453", both are chain ID 8453 = Base)
      const chainMap = new Map<number, ChainInfo>();

      const results = await Promise.allSettled(
        engine.getAllBackends().map((b) => b.getSupportedChains())
      );

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const chain of result.value) {
          const existing = chainMap.get(chain.id);
          if (existing) {
            // Merge providers from duplicate entries
            for (const p of chain.providers) {
              if (!existing.providers.includes(p)) existing.providers.push(p);
            }
            // Pick best name/key: canonical lookup > shorter name > existing
            const canonical = CHAIN_ID_NAMES[chain.id];
            if (canonical) {
              existing.name = canonical.name;
              existing.key = canonical.key;
            } else if (chain.name.length < existing.name.length) {
              existing.name = chain.name;
              existing.key = chain.key;
            }
          } else {
            // Use canonical name/key if available
            const canonical = CHAIN_ID_NAMES[chain.id];
            chainMap.set(chain.id, {
              ...chain,
              name: canonical?.name ?? chain.name,
              key: canonical?.key ?? chain.key,
            });
          }
        }
      }

      let chains = Array.from(chainMap.values()).sort((a, b) => {
        // Sort: well-known chains first (lower IDs), then alphabetically
        if (a.id < 10000 && b.id >= 10000) return -1;
        if (a.id >= 10000 && b.id < 10000) return 1;
        return a.name.localeCompare(b.name);
      });

      // Apply search filter if specified
      if (params.search) {
        const searchLower = params.search.toLowerCase();
        chains = chains.filter((c) =>
          c.name.toLowerCase().includes(searchLower) ||
          c.key.toLowerCase().includes(searchLower)
        );
      }

      // Categorize chains by ecosystem
      const cosmosKeys = new Set(["persistence", "cosmoshub", "osmosis", "neutron", "celestia", "injective", "sei", "dydx", "stride", "kujira"]);
      const solanaKeys = new Set(["solana"]);

      const evmChains = chains.filter((c) => !cosmosKeys.has(c.key) && !solanaKeys.has(c.key) && !isCosmosChain(c.id));
      const cosmos = chains.filter((c) => cosmosKeys.has(c.key) || isCosmosChain(c.id));
      // Solana routing is not supported in v1 — filter out any stray Solana entries from backend APIs
      const solana: ChainInfo[] = [];

      const formatChain = (c: ChainInfo) => ({ id: c.id, name: c.name, key: c.key, providers: c.providers });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                totalChains: chains.length,
                ecosystems: {
                  evm: {
                    count: evmChains.length,
                    chains: evmChains.map(formatChain),
                  },
                  cosmos: {
                    count: cosmos.length,
                    chains: cosmos.map(formatChain),
                  },
                  solana: {
                    count: solana.length,
                    chains: solana.map(formatChain),
                  },
                },
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
