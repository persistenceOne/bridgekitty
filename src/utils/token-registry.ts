/**
 * Verified Token Registry
 *
 * Security-first token symbol resolution. Only resolves to verified, canonical
 * token addresses from official deployments. NEVER falls back to unverified tokens.
 *
 * Sources:
 * - Circle's official USDC deployments
 * - Tether's official USDT deployments
 * - LI.FI's verified token list
 * - CoinGecko verified contracts
 * - Official bridge/wrapper contracts per chain
 *
 * If a token is not in this registry, resolution fails with a clear error.
 * Agents can always pass raw 0x addresses to bypass the registry.
 */

import { getChainName } from "./chains.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VerifiedToken {
  /** Canonical symbol (uppercase) */
  symbol: string;
  /** Human-readable name */
  name: string;
  /** Default token decimals */
  decimals: number;
  /** Per-chain decimal overrides (e.g. USDT is 18 decimals on BSC, 6 elsewhere) */
  decimalOverrides?: Record<number, number>;
  /** chainId → verified contract address */
  addresses: Record<number, string>;
}

export type TokenResolveResult =
  | { ok: true; address: string; decimals: number; symbol: string }
  | { ok: false; error: string };

// ─── Constants ──────────────────────────────────────────────────────────────

const NATIVE = "0x0000000000000000000000000000000000000000";

// ─── Chain IDs ──────────────────────────────────────────────────────────────
// Documented here for reference:
//   1       = Ethereum
//   10      = Optimism
//   56      = BNB Chain (BSC)
//   137     = Polygon
//   324     = zkSync Era
//   5000    = Mantle
//   8453    = Base
//   34443   = Mode
//   42161   = Arbitrum
//   43114   = Avalanche
//   59144   = Linea
//   81457   = Blast
//   534352  = Scroll
//   7777777 = Zora

// ─── Verified Token Registry ────────────────────────────────────────────────

export const VERIFIED_TOKENS: VerifiedToken[] = [
  // ── Native Tokens ──────────────────────────────────────────────────────

  {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    addresses: {
      1: NATIVE,
      10: NATIVE,
      42161: NATIVE,
      8453: NATIVE,
      59144: NATIVE,
      534352: NATIVE,
      324: NATIVE,
      81457: NATIVE,
      7777777: NATIVE,
      34443: NATIVE,
    },
  },
  {
    symbol: "BNB",
    name: "BNB",
    decimals: 18,
    addresses: {
      56: NATIVE,
    },
  },
  {
    symbol: "MATIC",
    name: "Polygon",
    decimals: 18,
    addresses: {
      137: NATIVE,
    },
  },
  {
    // POL is the rebranded MATIC — same native token on Polygon
    symbol: "POL",
    name: "Polygon (POL)",
    decimals: 18,
    addresses: {
      137: NATIVE,
    },
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    decimals: 18,
    addresses: {
      43114: NATIVE,
    },
  },
  {
    symbol: "MNT",
    name: "Mantle",
    decimals: 18,
    addresses: {
      5000: NATIVE,
    },
  },

  // ── Stablecoins ────────────────────────────────────────────────────────

  {
    // Circle's official native USDC deployments
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    decimalOverrides: { 56: 18 }, // BSC Binance-Peg uses 18 decimals
    addresses: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",       // Ethereum
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",      // Optimism (native)
      56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",      // BSC (Binance-Peg, 18 decimals!)
      137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",     // Polygon (native)
      42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",   // Arbitrum (native)
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",    // Base (native)
      43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",   // Avalanche (native)
    },
  },
  {
    // Bridged USDC.e (older, being deprecated in favor of native USDC)
    symbol: "USDC.E",
    name: "Bridged USD Coin",
    decimals: 6,
    addresses: {
      10: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",      // Optimism
      137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",     // Polygon
      42161: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",   // Arbitrum
      43114: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664",   // Avalanche
    },
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    decimalOverrides: { 56: 18 }, // BSC Binance-Peg uses 18 decimals
    addresses: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",       // Ethereum
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",      // Optimism
      56: "0x55d398326f99059fF775485246999027B3197955",       // BSC (Binance-Peg, 18 decimals!)
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",     // Polygon
      42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",   // Arbitrum
      43114: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",   // Avalanche
      8453: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",    // Base
    },
  },
  {
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    addresses: {
      1: "0x6B175474E89094C44Da98b954EedeAC495271d0F",       // Ethereum
      10: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",      // Optimism
      137: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",     // Polygon
      42161: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",   // Arbitrum
      43114: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70",   // Avalanche
      8453: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",    // Base
    },
  },
  {
    symbol: "USDS",
    name: "USDS (Sky Dollar)",
    decimals: 18,
    addresses: {
      1: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",       // Ethereum
    },
  },
  {
    symbol: "FRAX",
    name: "Frax",
    decimals: 18,
    addresses: {
      1: "0x853d955aCEf822Db058eb8505911ED77F175b99e",       // Ethereum
      10: "0x2E3D870790dC77A83DD1d22184567a97112523ab",      // Optimism
      137: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",     // Polygon
      42161: "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F",   // Arbitrum
      43114: "0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64",   // Avalanche
    },
  },
  {
    symbol: "GHO",
    name: "GHO (Aave)",
    decimals: 18,
    addresses: {
      1: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",       // Ethereum
      42161: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33",   // Arbitrum
    },
  },

  // ── Wrapped ETH ────────────────────────────────────────────────────────

  {
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    addresses: {
      1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",       // Ethereum
      10: "0x4200000000000000000000000000000000000006",        // Optimism
      56: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",       // BSC (Binance-Peg ETH)
      137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",     // Polygon
      42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",   // Arbitrum
      8453: "0x4200000000000000000000000000000000000006",      // Base
      43114: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",   // Avalanche (WETH.e)
      59144: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",   // Linea
      534352: "0x5300000000000000000000000000000000000004",    // Scroll
      324: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",     // zkSync
      81457: "0x4300000000000000000000000000000000000004",     // Blast
      5000: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",    // Mantle (WETH)
    },
  },

  // ── BTC Variants ───────────────────────────────────────────────────────

  {
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
    addresses: {
      1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",       // Ethereum
      10: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",      // Optimism
      137: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",     // Polygon
      42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",   // Arbitrum
      43114: "0x50b7545627a5162F82A992c33b87aDc75187B218",   // Avalanche
    },
  },
  {
    symbol: "BTCB",
    name: "Binance-Peg BTCB",
    decimals: 18,
    addresses: {
      56: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",      // BSC
    },
  },
  {
    symbol: "CBBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    addresses: {
      1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",       // Ethereum
      8453: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",    // Base
    },
  },
  {
    symbol: "TBTC",
    name: "Threshold BTC",
    decimals: 18,
    addresses: {
      1: "0x18084fbA666a33d37592fA2633fD49a74DD93a88",       // Ethereum
      10: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",      // Optimism
      137: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",     // Polygon
      42161: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",   // Arbitrum
      8453: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",    // Base
    },
  },

  // ── Liquid Staking Tokens ──────────────────────────────────────────────

  {
    symbol: "STETH",
    name: "Lido Staked ETH",
    decimals: 18,
    addresses: {
      1: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",       // Ethereum
    },
  },
  {
    symbol: "WSTETH",
    name: "Lido Wrapped Staked ETH",
    decimals: 18,
    addresses: {
      1: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",       // Ethereum
      10: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb",      // Optimism
      137: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD",     // Polygon
      42161: "0x5979D7b546E38E9Ab8a45CfA782CAa3c8539b40C",   // Arbitrum
      8453: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",    // Base
      534352: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",  // Scroll
      59144: "0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F",   // Linea
      5000: "0x636D4073738C071326Aa70fB30dB8e8F21aFabca",    // Mantle
    },
  },
  {
    symbol: "RETH",
    name: "Rocket Pool ETH",
    decimals: 18,
    addresses: {
      1: "0xae78736Cd615f374D3085123A210448E74Fc6393",       // Ethereum
      10: "0x9Bcef72be871e61ED4fBbc7630889beE758eb81D",      // Optimism
      42161: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8",   // Arbitrum
      8453: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c",    // Base
    },
  },
  {
    symbol: "CBETH",
    name: "Coinbase Staked ETH",
    decimals: 18,
    addresses: {
      1: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",       // Ethereum
      10: "0xadDb6A0412DE1BA0F936DCaeb8Aaa24578dcF3B2",      // Optimism
      8453: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",    // Base
      42161: "0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f",   // Arbitrum
    },
  },

  // ── Wrapped Native Tokens (non-ETH) ───────────────────────────────────

  {
    symbol: "WBNB",
    name: "Wrapped BNB",
    decimals: 18,
    addresses: {
      56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",      // BSC
    },
  },
  {
    symbol: "WMATIC",
    name: "Wrapped MATIC",
    decimals: 18,
    addresses: {
      137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",     // Polygon
    },
  },
  {
    symbol: "WAVAX",
    name: "Wrapped AVAX",
    decimals: 18,
    addresses: {
      43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",   // Avalanche
    },
  },

  // ── L2 Governance Tokens ───────────────────────────────────────────────

  {
    symbol: "ARB",
    name: "Arbitrum",
    decimals: 18,
    addresses: {
      42161: "0x912CE59144191C1204E64559FE8253a0e49E6548",   // Arbitrum
      1: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",       // Ethereum
    },
  },
  {
    symbol: "OP",
    name: "Optimism",
    decimals: 18,
    addresses: {
      10: "0x4200000000000000000000000000000000000042",        // Optimism
    },
  },

  // ── DeFi Blue Chips ────────────────────────────────────────────────────

  {
    symbol: "LINK",
    name: "Chainlink",
    decimals: 18,
    addresses: {
      1: "0x514910771AF9Ca656af840dff83E8264EcF986CA",       // Ethereum
      10: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",      // Optimism
      56: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",      // BSC
      137: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",     // Polygon
      42161: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",   // Arbitrum
      43114: "0x5947BB275c521040051D82396192181b413227A3",   // Avalanche
      8453: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196",    // Base
    },
  },
  {
    symbol: "UNI",
    name: "Uniswap",
    decimals: 18,
    addresses: {
      1: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",       // Ethereum
      10: "0x6fd9d7AD17242c41f7131d257212c54A0e816691",      // Optimism
      137: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",     // Polygon
      42161: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",   // Arbitrum
      56: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1",      // BSC
      43114: "0x8eBAf22B6F053dFFeaf46f4Dd9eFA95D89ba8580",   // Avalanche
      8453: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",    // Base
    },
  },
  {
    symbol: "AAVE",
    name: "Aave",
    decimals: 18,
    addresses: {
      1: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",       // Ethereum
      10: "0x76FB31fb4af56892A25e32cFC43De717950c9278",      // Optimism
      137: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",     // Polygon
      42161: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",   // Arbitrum
      43114: "0x63a72806098Bd3D9520cC43356dD78afe5D386D9",   // Avalanche
    },
  },
  {
    symbol: "MKR",
    name: "Maker",
    decimals: 18,
    addresses: {
      1: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",       // Ethereum
    },
  },
  {
    symbol: "CRV",
    name: "Curve DAO Token",
    decimals: 18,
    addresses: {
      1: "0xD533a949740bb3306d119CC777fa900bA034cd52",       // Ethereum
      10: "0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53",      // Optimism
      137: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",     // Polygon
      42161: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",   // Arbitrum
      43114: "0x249848BeCA43aC405b8102Ec90Dd5F22CA513c06",   // Avalanche
    },
  },
  {
    symbol: "LDO",
    name: "Lido DAO",
    decimals: 18,
    addresses: {
      1: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",       // Ethereum
      10: "0xFdb794692724153d1488CcdBE0C56c0C1EE1fabf",      // Optimism
      137: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756",     // Polygon
      42161: "0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60",   // Arbitrum
    },
  },
  {
    symbol: "SNX",
    name: "Synthetix",
    decimals: 18,
    addresses: {
      1: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",       // Ethereum
      10: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4",      // Optimism
    },
  },
  {
    symbol: "COMP",
    name: "Compound",
    decimals: 18,
    addresses: {
      1: "0xc00e94Cb662C3520282E6f5717214004A7f26888",       // Ethereum
      137: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c",     // Polygon
      42161: "0x354A6dA3fcde098F8389cad84b0182725c6C91dE",   // Arbitrum
      8453: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0",    // Base
    },
  },

  // ── Meme / High Cap ────────────────────────────────────────────────────

  {
    symbol: "PEPE",
    name: "Pepe",
    decimals: 18,
    addresses: {
      1: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",       // Ethereum
      42161: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",   // Arbitrum
    },
  },
  {
    symbol: "SHIB",
    name: "Shiba Inu",
    decimals: 18,
    addresses: {
      1: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",       // Ethereum
    },
  },
  {
    symbol: "DOGE",
    name: "Dogecoin (Bridged)",
    decimals: 8,
    addresses: {
      56: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",      // BSC (Binance-Peg)
    },
  },

  // ── Wrapped / Misc ─────────────────────────────────────────────────────

  {
    symbol: "SUSHI",
    name: "SushiSwap",
    decimals: 18,
    addresses: {
      1: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",       // Ethereum
      137: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",     // Polygon
      42161: "0xd4d42F0b6DEF4CE0383636770eF773390d85c61A",   // Arbitrum
    },
  },
  {
    symbol: "RPL",
    name: "Rocket Pool",
    decimals: 18,
    addresses: {
      1: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f",       // Ethereum
      42161: "0xB766039cc6DB368759C1E56B79AFfE831545A950",   // Arbitrum
    },
  },
  {
    symbol: "PENDLE",
    name: "Pendle",
    decimals: 18,
    addresses: {
      1: "0x808507121B80c02388fAd14726482e061B8da827",       // Ethereum
      42161: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",   // Arbitrum
    },
  },
  {
    symbol: "ENA",
    name: "Ethena",
    decimals: 18,
    addresses: {
      1: "0x57e114B691Db790C35207b2e685D4A43181e6061",       // Ethereum
    },
  },
  {
    symbol: "USDE",
    name: "USDe (Ethena)",
    decimals: 18,
    addresses: {
      1: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",       // Ethereum
      42161: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",   // Arbitrum
      8453: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",    // Base
    },
  },
];

// ─── Indexes (built once at module load) ────────────────────────────────────

/** Map of UPPERCASE symbol → array of VerifiedToken entries */
const symbolIndex = new Map<string, VerifiedToken[]>();

/** Map of lowercase(address):chainId → VerifiedToken */
const addressIndex = new Map<string, VerifiedToken>();

function buildIndexes() {
  for (const token of VERIFIED_TOKENS) {
    const key = token.symbol.toUpperCase();
    const existing = symbolIndex.get(key) ?? [];
    existing.push(token);
    symbolIndex.set(key, existing);

    for (const [chainIdStr, address] of Object.entries(token.addresses)) {
      const addrKey = `${address.toLowerCase()}:${chainIdStr}`;
      addressIndex.set(addrKey, token);
    }
  }
}

buildIndexes();

// ─── Resolution Functions ───────────────────────────────────────────────────

/**
 * Resolve a token input (symbol or 0x address) to a verified address.
 *
 * Security rules:
 * - If input is a 0x address: pass through unchanged (with known decimals if available)
 * - If input is a symbol: ONLY resolve to verified canonical addresses
 * - If symbol is unknown: return error with guidance
 * - If symbol is ambiguous (multiple tokens): return error listing options
 * - NEVER falls back to unverified tokens
 */
export function resolveToken(input: string, chainId: number): TokenResolveResult {
  const trimmed = input.trim();

  // 0x address passthrough — agent knows what they're doing
  if (trimmed.startsWith("0x") && trimmed.length === 42) {
    // Normalize alternative native token address (0xEeEe...) to canonical zero address
    let normalizedAddr = trimmed;
    if (trimmed.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      normalizedAddr = NATIVE;
    }
    const known = addressIndex.get(`${normalizedAddr.toLowerCase()}:${chainId}`);
    const decimals = known
      ? (known.decimalOverrides?.[chainId] ?? known.decimals)
      : 18;
    return {
      ok: true,
      address: normalizedAddr,
      decimals,
      symbol: known?.symbol ?? "UNKNOWN",
    };
  }

  // Symbol resolution — security-critical path
  const upper = trimmed.toUpperCase();
  const candidates = symbolIndex.get(upper);

  if (!candidates || candidates.length === 0) {
    const chainName = getChainName(chainId);
    return {
      ok: false,
      error: `Unknown token symbol '${trimmed}' on ${chainName} (chain ${chainId}). Use bridge_tokens to search, or provide the contract address directly.`,
    };
  }

  // Find all candidates that have an address on this chain
  const matches: { token: VerifiedToken; address: string }[] = [];
  for (const token of candidates) {
    const address = token.addresses[chainId];
    if (address) {
      matches.push({ token, address });
    }
  }

  if (matches.length === 0) {
    const chainName = getChainName(chainId);
    const availableChains = candidates
      .flatMap((t) => Object.keys(t.addresses).map(Number))
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .map((id) => `${getChainName(id)} (${id})`)
      .join(", ");
    return {
      ok: false,
      error: `Token '${trimmed}' is not available on ${chainName} (chain ${chainId}). Available on: ${availableChains}. Use bridge_tokens to search for alternatives, or provide a contract address directly.`,
    };
  }

  if (matches.length > 1) {
    const chainName = getChainName(chainId);
    const options = matches
      .map((m) => `  • ${m.token.symbol} (${m.token.name}): ${m.address}`)
      .join("\n");
    return {
      ok: false,
      error: `Ambiguous token symbol '${trimmed}' on ${chainName} (chain ${chainId}). Multiple verified tokens found:\n${options}\nSpecify the contract address directly to disambiguate.`,
    };
  }

  // Exactly one match — verified resolution
  const match = matches[0];
  const decimals = match.token.decimalOverrides?.[chainId] ?? match.token.decimals;
  return {
    ok: true,
    address: match.address,
    decimals,
    symbol: match.token.symbol,
  };
}

/**
 * Look up a verified token by address on a specific chain.
 * Returns null if not in the registry (the token may still be valid, just not curated).
 */
export function lookupByAddress(address: string, chainId: number): VerifiedToken | null {
  return addressIndex.get(`${address.toLowerCase()}:${chainId}`) ?? null;
}

/**
 * Get all verified tokens available on a specific chain.
 */
export function getVerifiedTokensForChain(chainId: number): Array<{
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}> {
  const results: Array<{
    symbol: string;
    name: string;
    address: string;
    decimals: number;
  }> = [];

  for (const token of VERIFIED_TOKENS) {
    const address = token.addresses[chainId];
    if (address) {
      const decimals = token.decimalOverrides?.[chainId] ?? token.decimals;
      results.push({
        symbol: token.symbol,
        name: token.name,
        address,
        decimals,
      });
    }
  }

  return results;
}

/**
 * Get the total number of unique tokens in the registry.
 */
export function getRegistryStats(): { tokenCount: number; chainCount: number } {
  const chains = new Set<number>();
  for (const token of VERIFIED_TOKENS) {
    for (const chainId of Object.keys(token.addresses)) {
      chains.add(Number(chainId));
    }
  }
  return {
    tokenCount: VERIFIED_TOKENS.length,
    chainCount: chains.size,
  };
}
