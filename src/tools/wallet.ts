import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { sanitizeError } from "../utils/sanitize-error.js";
import { getProvider } from "../utils/gas-estimator.js";

const REWARDS_API = "https://rewards.interop.persistence.one";
const TIMEOUT_MS = 15_000;

// H-1: In-memory key store — keys are NOT stored in process.env
const keyStore: { privateKey?: string; mnemonic?: string; solanaKey?: string } = {};

/** Read a key: keyStore first, then process.env fallback (clearing env after read) */
export function getKey(name: "privateKey" | "mnemonic" | "solanaKey"): string | undefined {
  if (keyStore[name]) return keyStore[name];
  const envMap = { privateKey: "PRIVATE_KEY", mnemonic: "MNEMONIC", solanaKey: "SOLANA_PRIVATE_KEY" } as const;
  const envKey = envMap[name];
  const val = process.env[envKey];
  if (val) {
    keyStore[name] = val;
    delete process.env[envKey]; // H-1: clear from env after reading
    return val;
  }
  return undefined;
}

/**
 * Returns the BridgeKitty config directory. Resolution order:
 * 1. BRIDGEKITTY_HOME env var (if set)
 * 2. ~/.bridgekitty/
 *
 * Creates the directory if it doesn't exist (mode 0o700).
 */
export function getConfigDir(): string {
  const dir = process.env.BRIDGEKITTY_HOME || path.join(os.homedir(), ".bridgekitty");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

const EVM_CHAINS: Record<string, { chainId: number; symbol: string }> = {
  ethereum:  { chainId: 1,      symbol: "ETH" },
  optimism:  { chainId: 10,     symbol: "ETH" },
  bsc:       { chainId: 56,     symbol: "BNB" },
  polygon:   { chainId: 137,    symbol: "POL" },
  arbitrum:  { chainId: 42161,  symbol: "ETH" },
  avalanche: { chainId: 43114,  symbol: "AVAX" },
  base:      { chainId: 8453,   symbol: "ETH" },
  linea:     { chainId: 59144,  symbol: "ETH" },
  scroll:    { chainId: 534352, symbol: "ETH" },
  zksync:    { chainId: 324,    symbol: "ETH" },
  mantle:    { chainId: 5000,   symbol: "MNT" },
  blast:     { chainId: 81457,  symbol: "ETH" },
};

const PERSISTENCE_REST = "https://rest.core.persistence.one";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

// Key ERC-20 tokens to check by default on each chain
const DEFAULT_ERC20_TOKENS: Record<number, Array<{ symbol: string; address: string; decimals: number }>> = {
  1: [ // Ethereum
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  ],
  10: [ // Optimism
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  ],
  56: [ // BSC
    { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    { symbol: "WETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
  ],
  137: [ // Polygon
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    { symbol: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
  ],
  42161: [ // Arbitrum
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
  ],
  43114: [ // Avalanche
    { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    { symbol: "WETH", address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18 },
    { symbol: "WBTC", address: "0x50b7545627a5162F82A992c33b87aDc75187B218", decimals: 8 },
  ],
  8453: [ // Base
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  ],
};

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

// ─── USD Price Cache ─────────────────────────────────────────────────────
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const PRICE_CACHE_TTL_MS = 60_000; // 60 seconds
let priceCache: { prices: Record<string, number>; fetchedAt: number } | null = null;

// CoinGecko IDs for native tokens
const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum",
  BNB: "binancecoin",
  POL: "matic-network",
  MATIC: "matic-network",
  AVAX: "avalanche-2",
  MNT: "mantle",
  XPRT: "persistence",
  SOL: "solana",
  BTC: "bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
};

async function fetchUsdPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  if (priceCache && now - priceCache.fetchedAt < PRICE_CACHE_TTL_MS) {
    return priceCache.prices;
  }

  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${COINGECKO_API}/simple/price?ids=${ids}&vs_currencies=usd`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const data = await res.json();

      const prices: Record<string, number> = {};
      for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
        if (data[cgId]?.usd) {
          prices[symbol] = data[cgId].usd;
        }
      }
      priceCache = { prices, fetchedAt: now };
      return prices;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Return cached prices if available, even if stale
    return priceCache?.prices ?? {};
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function registerWalletTools(server: McpServer) {
  // ─── wallet_status ────────────────────────────────────────────────────────
  server.tool(
    "wallet_status",
    "Check if a wallet is configured. Returns wallet address, key status, and config file location. Call this FIRST before wallet_setup or wallet_import.",
    {},
    async () => {
      const configDir = getConfigDir();
      const envPath = path.resolve(configDir, ".env");
      const hasEnvFile = fs.existsSync(envPath);
      const pk = getKey("privateKey");
      const mn = getKey("mnemonic");
      const sol = getKey("solanaKey");

      if (pk) {
        const address = new ethers.Wallet(pk).address;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "ready",
              wallet: address,
              hasPrivateKey: true,
              hasMnemonic: !!mn,
              hasSolanaKey: !!sol,
              configFile: envPath,
              chains: {
                evm: Object.keys(EVM_CHAINS),
                persistence: mn ? "available" : "unavailable (no mnemonic)",
                solana: sol ? "available" : "unavailable (no solana key)",
              },
            }, null, 2),
          }],
        };
      }

      // No wallet loaded
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "not_configured",
            configFile: envPath,
            configFileExists: hasEnvFile,
            hint: hasEnvFile
              ? `Config file exists at ${envPath} but no keys were loaded. Check format: MNEMONIC=word1 word2 ... and/or PRIVATE_KEY=0x...`
              : `No wallet configured. Either: (1) run wallet_setup to generate a new wallet, or (2) add keys to ${envPath} with format: MNEMONIC=word1 word2 ... / PRIVATE_KEY=0x...`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── wallet_setup ─────────────────────────────────────────────────────────
  server.tool(
    "wallet_setup",
    "Create wallets for all supported chains (EVM, Cosmos, Solana). Keys saved to ~/.bridgekitty/.env. Use wallet_status first to check if already configured.",
    {},
    async () => {
      try {
        // C-1: Check if .env already exists with keys — refuse to overwrite
        const envPath = path.resolve(getConfigDir(), ".env");
        if (fs.existsSync(envPath)) {
          const existing = fs.readFileSync(envPath, "utf-8");
          if (existing.includes("PRIVATE_KEY")) {
            return {
              content: [{
                type: "text" as const,
                text: `ERROR: ${envPath} already contains PRIVATE_KEY. To regenerate wallets, delete the existing file first (back it up!). This safeguard prevents accidental key loss.`,
              }],
              isError: true,
            };
          }
        }

        // 1. Generate a single mnemonic (24 words) — used for ALL chains
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const cosmosWallet = await Secp256k1HdWallet.generate(24, { prefix: "persistence" });
        const [cosmosAccount] = await cosmosWallet.getAccounts();
        const persistenceAddress = cosmosAccount.address;
        const mnemonic = cosmosWallet.mnemonic;

        // 2. Derive EVM wallet from the same mnemonic (BIP-44 m/44'/60'/0'/0/0)
        const evmWallet = ethers.HDNodeWallet.fromMnemonic(
          ethers.Mnemonic.fromPhrase(mnemonic),
          "m/44'/60'/0'/0/0"
        );
        const evmAddress = evmWallet.address;
        const privateKey = evmWallet.privateKey;

        // 3. Derive Solana wallet from the same mnemonic (BIP-44 m/44'/501'/0'/0')
        let solanaAddress: string;
        let solanaPrivateKey: string;
        try {
          const { Keypair } = await import("@solana/web3.js");
          const { derivePath } = await import("ed25519-hd-key") as any;
          const bip39 = await import("@scure/bip39") as any;
          const seed = await bip39.mnemonicToSeed(mnemonic);
          const derived = derivePath("m/44'/501'/0'/0'", Buffer.from(seed).toString("hex"));
          const solanaKeypair = Keypair.fromSeed(derived.key);
          solanaAddress = solanaKeypair.publicKey.toBase58();
          const bs58 = await import("bs58");
          solanaPrivateKey = bs58.default.encode(solanaKeypair.secretKey);
        } catch (depErr) {
          // M-4: No silent fallback — tell user to install deps
          const msg = (depErr as Error).message || "";
          if (msg.includes("Cannot find") || msg.includes("MODULE_NOT_FOUND") || msg.includes("ed25519-hd-key") || msg.includes("@scure/bip39")) {
            return {
              content: [{
                type: "text" as const,
                text: "Solana key derivation failed: missing dependency. Install with: npm install ed25519-hd-key @scure/bip39",
              }],
              isError: true,
            };
          }
          throw depErr;
        }

        // 4. Save to .env
        const envContent = `MNEMONIC=${mnemonic}\nPRIVATE_KEY=${privateKey}\nSOLANA_PRIVATE_KEY=${solanaPrivateKey}\n`;
        fs.writeFileSync(envPath, envContent, { mode: 0o600 });

        // H-1: Set in keyStore, NOT process.env
        keyStore.privateKey = privateKey;
        keyStore.mnemonic = mnemonic;
        keyStore.solanaKey = solanaPrivateKey;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "success",
              wallets: {
                evm: {
                  address: evmAddress,
                  chains: Object.keys(EVM_CHAINS),
                },
                persistence: persistenceAddress,
                solana: solanaAddress,
              },
              note: "⚠️ IMPORTANT: Back up your .env file NOW — it contains your private keys. If lost, your funds are unrecoverable. Store a copy in a secure location.",
              envPath,
              nextStep: "Fund your EVM wallet to start bridging. Use xprt_farm_prepare to start XPRT farming.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Setup failed: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── wallet_balance ───────────────────────────────────────────────────────
  server.tool(
    "wallet_balance",
    "Check wallet balances across EVM, Cosmos, and Solana chains. " +
    "Returns native token balances AND key ERC-20 token balances (USDC, USDT, WETH, WBTC, cbBTC, BTCB) by default. " +
    "Uses multiple RPCs with automatic failover. " +
    "Returns per-token balance, USD value (via CoinGecko), and total portfolio value. " +
    "Call this before any bridging or farming operation to verify sufficient funds and gas.",
    {
      chains: z.array(z.string()).optional().describe("Chains to check (default: all). Options: ethereum, optimism, bsc, polygon, arbitrum, avalanche, base, linea, scroll, zksync, mantle, blast, persistence, solana"),
      includeUsd: z.boolean().default(true).describe("Include USD valuations for each balance (default: true). Uses CoinGecko prices, cached for 60s."),
      includeTokens: z.boolean().default(true).describe("Include ERC-20 token balances (USDC, USDT, WETH, WBTC, cbBTC, BTCB). Default: true."),
      tokens: z.record(z.string(), z.array(z.object({
        address: z.string().describe("Token contract address (0x...)"),
        symbol: z.string().describe("Token symbol"),
        decimals: z.number().describe("Token decimals"),
      }))).optional().describe("Custom tokens to check per chain, e.g. { \"base\": [{ \"address\": \"0x...\", \"symbol\": \"FOO\", \"decimals\": 18 }] }"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      const mnemonic = getKey("mnemonic");
      const solanaKey = getKey("solanaKey");

      if (!privateKey) {
        const envPath = path.resolve(getConfigDir(), ".env");
        return {
          content: [{ type: "text" as const, text: `No wallet configured. Add keys to ${envPath} (MNEMONIC=... / PRIVATE_KEY=0x...) or run wallet_setup to generate new keys. Use wallet_status to check.` }],
          isError: true,
        };
      }

      const evmAddress = new ethers.Wallet(privateKey).address;
      const chainsToCheck = params.chains ?? [...Object.keys(EVM_CHAINS), "persistence", "solana"];

      // Fetch USD prices in parallel with balance checks
      const pricesPromise = params.includeUsd ? fetchUsdPrices() : Promise.resolve({} as Record<string, number>);

      interface BalanceEntry {
        balance: string;
        symbol: string;
        usdValue?: number | null;
        error?: string;
      }
      const balances: Record<string, BalanceEntry> = {};

      // EVM chains — same address on all chains, fetch balances in parallel
      const evmChains = chainsToCheck
        .filter((c) => EVM_CHAINS[c])
        .map((c) => ({ name: c, ...EVM_CHAINS[c] }));

      const evmResults = await Promise.allSettled(
        evmChains.map(async (chain) => {
          const provider = await getProvider(chain.chainId);
          const bal = await provider.getBalance(evmAddress);
          return { name: chain.name, symbol: chain.symbol, balance: ethers.formatEther(bal) };
        })
      );

      const prices = await pricesPromise;

      for (const result of evmResults) {
        if (result.status === "fulfilled") {
          const { name, symbol, balance } = result.value;
          const entry: BalanceEntry = { balance, symbol };
          if (params.includeUsd) {
            const price = prices[symbol];
            entry.usdValue = price ? Math.round(parseFloat(balance) * price * 100) / 100 : null;
          }
          balances[`${name} (${symbol})`] = entry;
        } else {
          const idx = evmResults.indexOf(result);
          const chain = evmChains[idx];
          balances[`${chain.name} (${chain.symbol})`] = {
            balance: "0",
            symbol: chain.symbol,
            usdValue: null,
            error: `RPC unavailable: ${sanitizeError(result.reason as Error)}`,
          };
        }
      }

      // ERC-20 token balances
      if (params.includeTokens !== false) {
        const erc20Promises: Array<Promise<{ key: string; symbol: string; balance: string } | null>> = [];

        for (const chain of evmChains) {
          // Get default tokens for this chain
          let tokensToCheck = DEFAULT_ERC20_TOKENS[chain.chainId] ?? [];

          // Add custom tokens if specified
          if (params.tokens?.[chain.name]) {
            tokensToCheck = [...tokensToCheck, ...params.tokens[chain.name]];
          }

          for (const token of tokensToCheck) {
            erc20Promises.push(
              (async () => {
                try {
                  const provider = await getProvider(chain.chainId);
                  const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
                  const bal: bigint = await contract.balanceOf(evmAddress);
                  const balance = ethers.formatUnits(bal, token.decimals);
                  return { key: `${chain.name} (${token.symbol})`, symbol: token.symbol, balance };
                } catch {
                  // Return zero balance so default tokens always appear in output
                  return { key: `${chain.name} (${token.symbol})`, symbol: token.symbol, balance: "0" };
                }
              })()
            );
          }
        }

        const erc20Results = await Promise.allSettled(erc20Promises);
        for (const result of erc20Results) {
          if (result.status === "fulfilled" && result.value !== null) {
            const { key, symbol, balance } = result.value;
            const entry: BalanceEntry = { balance, symbol };
            if (params.includeUsd) {
              // Map ERC-20 symbols to price keys
              const priceKey: Record<string, string> = {
                USDC: "USDC", USDT: "USDT", WETH: "ETH", WBTC: "BTC",
                cbBTC: "BTC", BTCB: "BTC", DAI: "USDC",
              };
              const pk = priceKey[symbol];
              if (pk && prices[pk]) {
                entry.usdValue = Math.round(parseFloat(balance) * prices[pk] * 100) / 100;
              } else if (["USDC", "USDT", "DAI"].includes(symbol)) {
                entry.usdValue = Math.round(parseFloat(balance) * 100) / 100; // ~$1 fallback
              } else {
                entry.usdValue = null;
              }
            }
            balances[key] = entry;
          }
        }
      }

      // Persistence XPRT
      if (chainsToCheck.includes("persistence") && mnemonic) {
        try {
          const { Secp256k1HdWallet } = await import("@cosmjs/amino");
          const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
          const [account] = await wallet.getAccounts();
          const data = await fetchJson(`${PERSISTENCE_REST}/cosmos/bank/v1beta1/balances/${account.address}`);
          const xprt = data.balances?.find((b: any) => b.denom === "uxprt");
          const amount = xprt ? (parseInt(xprt.amount) / 1e6).toFixed(6) : "0";
          const entry: BalanceEntry = { balance: amount, symbol: "XPRT" };
          if (params.includeUsd) {
            const price = prices["XPRT"];
            entry.usdValue = price ? Math.round(parseFloat(amount) * price * 100) / 100 : null;
          }
          balances["persistence (XPRT)"] = entry;
        } catch (err) {
          balances["persistence (XPRT)"] = { balance: `error: ${sanitizeError(err as Error)}`, symbol: "XPRT", usdValue: null };
        }
      }

      // Solana
      if (chainsToCheck.includes("solana") && solanaKey) {
        try {
          const bs58 = await import("bs58");
          const { Keypair, Connection } = await import("@solana/web3.js");
          const secretKey = bs58.default.decode(solanaKey);
          const keypair = Keypair.fromSecretKey(secretKey);
          const connection = new Connection(SOLANA_RPC);
          const lamports = await connection.getBalance(keypair.publicKey);
          const solBalance = (lamports / 1e9).toFixed(9);
          const entry: BalanceEntry = { balance: solBalance, symbol: "SOL" };
          if (params.includeUsd) {
            const price = prices["SOL"];
            entry.usdValue = price ? Math.round(parseFloat(solBalance) * price * 100) / 100 : null;
          }
          balances["solana (SOL)"] = entry;
        } catch (err) {
          balances["solana (SOL)"] = { balance: `error: ${sanitizeError(err as Error)}`, symbol: "SOL", usdValue: null };
        }
      }

      // Calculate total portfolio USD value
      let totalPortfolioUsd: number | null = null;
      if (params.includeUsd) {
        let total = 0;
        let hasAnyPrice = false;
        for (const entry of Object.values(balances)) {
          if (entry.usdValue !== null && entry.usdValue !== undefined && entry.usdValue > 0) {
            total += entry.usdValue;
            hasAnyPrice = true;
          }
        }
        totalPortfolioUsd = hasAnyPrice ? Math.round(total * 100) / 100 : null;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            wallet: evmAddress,
            balances,
            ...(params.includeUsd ? { totalPortfolioUsd } : {}),
          }, null, 2),
        }],
      };
    }
  );

  // ─── wallet_import ──────────────────────────────────────────────────────
  server.tool(
    "wallet_import",
    "Import existing keys. Alternative: edit ~/.bridgekitty/.env directly (MNEMONIC=<words>, PRIVATE_KEY=0x<hex>). Mnemonic gives EVM + Persistence + Solana; privateKey alone gives EVM only. Use wallet_status to check current state.",
    {
      mnemonic: z.string().optional().describe("12 or 24 word BIP-39 mnemonic phrase"),
      privateKey: z.string().optional().describe("0x-prefixed hex EVM private key"),
      overwrite: z.boolean().default(false).describe("Set true to overwrite existing keys (back up first!)"),
    },
    async (params) => {
      try {
        // Validate: at least one must be provided
        if (!params.mnemonic && !params.privateKey) {
          return {
            content: [{ type: "text" as const, text: "ERROR: Provide at least one of 'mnemonic' or 'privateKey'." }],
            isError: true,
          };
        }

        // Validate privateKey format
        let evmAddress: string | undefined;
        if (params.privateKey) {
          if (!/^0x[a-fA-F0-9]{64}$/.test(params.privateKey)) {
            return {
              content: [{ type: "text" as const, text: "ERROR: privateKey must be 0x-prefixed followed by 64 hex characters." }],
              isError: true,
            };
          }
          try {
            evmAddress = new ethers.Wallet(params.privateKey).address;
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: `ERROR: Invalid private key: ${sanitizeError(e as Error)}` }],
              isError: true,
            };
          }
        }

        // Validate mnemonic
        if (params.mnemonic) {
          const words = params.mnemonic.trim().split(/\s+/);
          if (words.length !== 12 && words.length !== 24) {
            return {
              content: [{ type: "text" as const, text: `ERROR: Mnemonic must be 12 or 24 words. Got ${words.length}.` }],
              isError: true,
            };
          }
          try {
            ethers.Mnemonic.fromPhrase(params.mnemonic.trim());
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: `ERROR: Invalid BIP-39 mnemonic: ${sanitizeError(e as Error)}` }],
              isError: true,
            };
          }
        }

        // C-1: Overwrite protection
        const envPath = path.resolve(getConfigDir(), ".env");
        if (!params.overwrite && fs.existsSync(envPath)) {
          const existing = fs.readFileSync(envPath, "utf-8");
          if (existing.includes("PRIVATE_KEY") || existing.includes("MNEMONIC")) {
            return {
              content: [{
                type: "text" as const,
                text: `ERROR: ${envPath} already contains keys. Pass overwrite=true to replace (back up first!).`,
              }],
              isError: true,
            };
          }
        }

        // Derive addresses
        const wallets: Record<string, any> = {};
        let finalPrivateKey = params.privateKey;
        const finalMnemonic = params.mnemonic?.trim();
        let solanaPrivateKey: string | undefined;

        if (finalMnemonic) {
          // Derive EVM from mnemonic (only if no explicit privateKey)
          if (!finalPrivateKey) {
            const hdWallet = ethers.HDNodeWallet.fromMnemonic(
              ethers.Mnemonic.fromPhrase(finalMnemonic),
              "m/44'/60'/0'/0/0"
            );
            finalPrivateKey = hdWallet.privateKey;
            evmAddress = hdWallet.address;
          }

          // Derive Persistence address
          const { Secp256k1HdWallet } = await import("@cosmjs/amino");
          const cosmosWallet = await Secp256k1HdWallet.fromMnemonic(finalMnemonic, { prefix: "persistence" });
          const [cosmosAccount] = await cosmosWallet.getAccounts();
          wallets.persistence = cosmosAccount.address;

          // Derive Solana address
          try {
            const { Keypair } = await import("@solana/web3.js");
            const { derivePath } = await import("ed25519-hd-key") as any;
            const bip39 = await import("@scure/bip39") as any;
            const seed = await bip39.mnemonicToSeed(finalMnemonic);
            const derived = derivePath("m/44'/501'/0'/0'", Buffer.from(seed).toString("hex"));
            const solanaKeypair = Keypair.fromSeed(derived.key);
            const bs58 = await import("bs58");
            solanaPrivateKey = bs58.default.encode(solanaKeypair.secretKey);
            wallets.solana = solanaKeypair.publicKey.toBase58();
          } catch (depErr) {
            const msg = (depErr as Error).message || "";
            if (msg.includes("Cannot find") || msg.includes("MODULE_NOT_FOUND") || msg.includes("ed25519-hd-key") || msg.includes("@scure/bip39")) {
              wallets.solana = "skipped (install ed25519-hd-key @scure/bip39 for Solana support)";
            } else {
              throw depErr;
            }
          }
        }

        wallets.evm = { address: evmAddress, chains: Object.keys(EVM_CHAINS) };

        // Write .env
        let envContent = "";
        if (finalMnemonic) envContent += `MNEMONIC=${finalMnemonic}\n`;
        if (finalPrivateKey) envContent += `PRIVATE_KEY=${finalPrivateKey}\n`;
        if (solanaPrivateKey) envContent += `SOLANA_PRIVATE_KEY=${solanaPrivateKey}\n`;

        fs.writeFileSync(envPath, envContent, { mode: 0o600 });

        // H-1: Update in-memory keyStore
        if (finalPrivateKey) keyStore.privateKey = finalPrivateKey;
        if (finalMnemonic) keyStore.mnemonic = finalMnemonic;
        if (solanaPrivateKey) keyStore.solanaKey = solanaPrivateKey;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "imported",
              wallets,
              envPath,
              note: "⚠️ Keys saved. Back up your .env file securely.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Import failed: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }
    }
  );
}
