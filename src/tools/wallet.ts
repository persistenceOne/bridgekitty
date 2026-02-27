import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { sanitizeError } from "../utils/sanitize-error.js";

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

const EVM_RPC_URLS: Record<string, { chainId: number; rpc: string; symbol: string }> = {
  ethereum: { chainId: 1, rpc: "https://eth.llamarpc.com", symbol: "ETH" },
  base: { chainId: 8453, rpc: "https://mainnet.base.org", symbol: "ETH" },
  bsc: { chainId: 56, rpc: "https://bsc-dataseed1.binance.org", symbol: "BNB" },
};

const PERSISTENCE_REST = "https://rest.core.persistence.one";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

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
  // ─── wallet_setup ─────────────────────────────────────────────────────────
  server.tool(
    "wallet_setup",
    "Create wallets for all supported chains (EVM, Cosmos, Solana) from a single mnemonic. Run this once — keys are saved to .env.",
    {},
    async () => {
      try {
        // C-1: Check if .env already exists with keys — refuse to overwrite
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
          const existing = fs.readFileSync(envPath, "utf-8");
          if (existing.includes("PRIVATE_KEY")) {
            return {
              content: [{
                type: "text" as const,
                text: "ERROR: .env file already contains PRIVATE_KEY. To regenerate wallets, delete the existing .env file first (back it up!) or use a different directory. This safeguard prevents accidental key loss.",
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
                evm: evmAddress,
                persistence: persistenceAddress,
                solana: solanaAddress,
              },
              note: "⚠️ IMPORTANT: Back up your .env file NOW — it contains your private keys. If lost, your funds are unrecoverable. Store a copy in a secure location.",
              envPath,
              nextStep: "Fund your EVM wallet to start bridging. Use persistence_rewards_prepare to join the XPRT rewards campaign.",
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
    "Check wallet balances across all chains (EVM, Cosmos, Solana).",
    {
      chains: z.array(z.string()).optional().describe("Chains to check (default: all). Options: ethereum, base, bsc, persistence, solana"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      const mnemonic = getKey("mnemonic");
      const solanaKey = getKey("solanaKey");

      if (!privateKey) {
        return {
          content: [{ type: "text" as const, text: "PRIVATE_KEY not set. Run wallet_setup first." }],
          isError: true,
        };
      }

      const evmAddress = new ethers.Wallet(privateKey).address;
      const chainsToCheck = params.chains ?? ["ethereum", "base", "bsc", "persistence", "solana"];
      const balances: Record<string, string> = {};

      // EVM chains
      for (const chain of chainsToCheck) {
        const evmChain = EVM_RPC_URLS[chain];
        if (!evmChain) continue;
        try {
          const provider = new ethers.JsonRpcProvider(evmChain.rpc);
          const bal = await provider.getBalance(evmAddress);
          balances[`${chain} (${evmChain.symbol})`] = ethers.formatEther(bal);
        } catch (err) {
          balances[`${chain} (${evmChain.symbol})`] = `error: ${sanitizeError(err as Error)}`;
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
          balances["persistence (XPRT)"] = amount;
        } catch (err) {
          balances["persistence (XPRT)"] = `error: ${sanitizeError(err as Error)}`;
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
          balances["solana (SOL)"] = (lamports / 1e9).toFixed(9);
        } catch (err) {
          balances["solana (SOL)"] = `error: ${sanitizeError(err as Error)}`;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ wallet: evmAddress, balances }, null, 2),
        }],
      };
    }
  );
}
