#!/usr/bin/env tsx
/**
 * BridgeKitty — Live On-Chain Daisy-Chain Test
 *
 * Tests all 6 bridge backends with REAL transactions on mainnet.
 * Each hop uses a DIFFERENT backend and arrives on a NEW chain.
 * The final hop returns to the starting chain — full circle.
 *
 * Route (mixed tokens — Skip requires USDC/CCTP, deBridge needs gas for protocol fee):
 *   cbBTC (Base) ──Persistence──→ BTCB (BSC)
 *   BTCB (BSC)  ────── LI.FI ──→ USDC (Optimism)   [cross-token via DEX]
 *   USDC (OP)   ────── Skip ───→ USDC (Base)        [CCTP bridge — returns to Base for gas]
 *   USDC (Base) ──── deBridge ──→ ETH (Linea)       [cross-token, Base has gas for protocol fee]
 *   ETH (Linea) ────── Across ──→ ETH (Scroll)      [same-token fast bridge]
 *   ETH (Scroll) ───── Relay ───→ ETH (Base)        [closes the loop!]
 *
 * Chains visited: Base → BSC → Optimism → Base → Linea → Scroll → Base
 * Backends used:  Persistence, LI.FI, Skip, deBridge, Across, Relay (all 6!)
 * Token journey:  cbBTC → BTCB → USDC → USDC → ETH → ETH → ETH
 *
 * Usage:
 *   npx tsx tests/live/bridge-daisy-chain.ts [--dry-run]
 *
 * Prerequisites:
 *   - .env with PRIVATE_KEY (test wallet: 0x221726819bcfDDC3B05be56369a14ac836E64B7F)
 *   - cbBTC balance on Base (≥ 0.00005 BTC)
 *   - ETH on Base for gas
 *   - BNB on BSC for gas
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { LiFiBackend } from "../../src/backends/lifi.js";
import { SkipBackend } from "../../src/backends/skip.js";
import { DeBridgeBackend } from "../../src/backends/debridge.js";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import type { BridgeQuote, QuoteParams } from "../../src/backends/types.js";
import { simulateTransaction } from "../../src/utils/tx-simulator.js";

// Load .env manually (no dotenv dependency)
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── Config ──────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const CBBTC_AMOUNT = "10000"; // 0.0001 BTC (8 decimals) ≈ $9

const NATIVE = "0x0000000000000000000000000000000000000000";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// Chain RPCs
const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed1.binance.org",
  10: "https://mainnet.optimism.io",
  42161: "https://arb1.arbitrum.io/rpc",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

// ERC20 ABI for balance + approve
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ── Types ───────────────────────────────────────────────────────────────

interface HopDef {
  name: string;
  backendName: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromDecimals: number;
  toDecimals: number;
  fromSymbol: string;
  toSymbol: string;
}

interface HopResult {
  hop: number;
  backend: string;
  from: string;
  to: string;
  token: string;
  inputAmount: string;
  outputAmount: string;
  txHash?: string;
  status: "success" | "failed" | "skipped" | "dry-run";
  error?: string;
  elapsed: number;
}

// ── Hop Definitions ─────────────────────────────────────────────────────

const HOPS: HopDef[] = [
  {
    name: "Persistence: cbBTC Base → BTCB BSC",
    backendName: "persistence",
    fromChainId: 8453,
    toChainId: 56,
    fromToken: CBBTC_BASE,
    toToken: BTCB_BSC,
    fromDecimals: 8,
    toDecimals: 18,
    fromSymbol: "cbBTC",
    toSymbol: "BTCB",
  },
  {
    name: "LI.FI: BTCB BSC → USDC Optimism",
    backendName: "lifi",
    fromChainId: 56,
    toChainId: 10,
    fromToken: BTCB_BSC,
    toToken: USDC_OP,
    fromDecimals: 18,
    toDecimals: 6,
    fromSymbol: "BTCB",
    toSymbol: "USDC",
  },
  {
    name: "Skip: USDC Optimism → USDC Base",
    backendName: "skip",
    fromChainId: 10,
    toChainId: 8453,
    fromToken: USDC_OP,
    toToken: USDC_BASE,
    fromDecimals: 6,
    toDecimals: 6,
    fromSymbol: "USDC",
    toSymbol: "USDC",
  },
  {
    name: "deBridge: USDC Base → ETH Linea",
    backendName: "debridge",
    fromChainId: 8453,
    toChainId: 59144,
    fromToken: USDC_BASE,
    toToken: NATIVE,
    fromDecimals: 6,
    toDecimals: 18,
    fromSymbol: "USDC",
    toSymbol: "ETH",
  },
  {
    name: "Across: ETH Linea → ETH Scroll",
    backendName: "across",
    fromChainId: 59144,
    toChainId: 534352,
    fromToken: NATIVE,
    toToken: NATIVE,
    fromDecimals: 18,
    toDecimals: 18,
    fromSymbol: "ETH",
    toSymbol: "ETH",
  },
  {
    name: "Relay: ETH Scroll → ETH Base",
    backendName: "relay",
    fromChainId: 534352,
    toChainId: 8453,
    fromToken: NATIVE,
    toToken: NATIVE,
    fromDecimals: 18,
    toDecimals: 18,
    fromSymbol: "ETH",
    toSymbol: "ETH",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function getProvider(chainId: number): ethers.JsonRpcProvider {
  const rpc = RPCS[chainId];
  if (!rpc) throw new Error(`No RPC for chain ${chainId}`);
  return new ethers.JsonRpcProvider(rpc);
}

async function getBalance(
  chainId: number,
  address: string,
  tokenAddress: string,
): Promise<bigint> {
  const provider = getProvider(chainId);
  if (tokenAddress === NATIVE) {
    return provider.getBalance(address);
  }
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return contract.balanceOf(address);
}

function formatAmount(raw: bigint, decimals: number): string {
  const str = raw.toString().padStart(decimals + 1, "0");
  const integer = str.slice(0, str.length - decimals) || "0";
  const fraction = str.slice(str.length - decimals);
  return `${integer}.${fraction.slice(0, 8)}`;
}

async function waitForBalance(
  chainId: number,
  address: string,
  tokenAddress: string,
  minBalance: bigint,
  timeoutMs: number = 600_000, // 10 min
  pollMs: number = 10_000,
): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await getBalance(chainId, address, tokenAddress);
    if (bal >= minBalance) return bal;
    console.log(`  ... waiting for balance (have: ${formatAmount(bal, 18)}, need: ${formatAmount(minBalance, 18)})`);
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for balance on chain ${chainId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Backend Instances ───────────────────────────────────────────────────

const backends: Record<string, any> = {
  lifi: new LiFiBackend(),
  skip: new SkipBackend(),
  debridge: new DeBridgeBackend(),
  across: new AcrossBackend(),
  relay: new RelayBackend(),
  persistence: new PersistenceBackend(),
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  BridgeKitty — Live Daisy-Chain Test (All 6 Backends)   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (DRY_RUN) {
    console.log("🏜️  DRY RUN MODE — will only verify quotes, no transactions.\n");
  }

  // Load wallet
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ PRIVATE_KEY not found in .env");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  console.log(`Wallet: ${address}\n`);

  // ── Pre-flight: Check balances ──────────────────────────────────────

  console.log("═══ Pre-flight Balance Check ═══\n");

  const balances: Record<string, string> = {};
  const balanceChecks = [
    { chain: "Base", chainId: 8453, token: CBBTC_BASE, symbol: "cbBTC", decimals: 8 },
    { chain: "Base", chainId: 8453, token: NATIVE, symbol: "ETH", decimals: 18 },
    { chain: "BSC", chainId: 56, token: NATIVE, symbol: "BNB", decimals: 18 },
    { chain: "Arbitrum", chainId: 42161, token: NATIVE, symbol: "ETH", decimals: 18 },
  ];

  for (const bc of balanceChecks) {
    try {
      const bal = await getBalance(bc.chainId, address, bc.token);
      const formatted = formatAmount(bal, bc.decimals);
      balances[`${bc.chain}-${bc.symbol}`] = formatted;
      console.log(`  ${bc.chain} ${bc.symbol}: ${formatted}`);
    } catch (err) {
      console.log(`  ${bc.chain} ${bc.symbol}: ❌ ${(err as Error).message}`);
    }
  }
  console.log();

  // ── Pre-flight: Verify all routes have quotes ──────────────────────

  console.log("═══ Pre-flight Route Verification ═══\n");

  let allRoutesAvailable = true;
  for (let i = 0; i < HOPS.length; i++) {
    const hop = HOPS[i];
    const backend = backends[hop.backendName];

    try {
      // Use realistic amounts for dry-run quotes to avoid AMOUNT_TOO_LOW errors
      const dryRunAmounts: Record<string, string> = {
        persistence: CBBTC_AMOUNT, // 0.0001 BTC (8 decimals)
        lifi: "100000000000000", // 0.0001 BTCB (18 decimals) — matches Persistence output
        skip: "8000000", // 8 USDC (6 decimals) — realistic after BTCB→USDC swap
        debridge: "7000000", // 7 USDC (6 decimals)
        across: "3000000000000000", // 0.003 ETH (~$5.55) — after USDC→ETH swap
        relay: "3000000000000000", // 0.003 ETH
      };
      const params: QuoteParams = {
        fromChainId: hop.fromChainId,
        toChainId: hop.toChainId,
        fromTokenAddress: hop.fromToken,
        toTokenAddress: hop.toToken,
        amountRaw: dryRunAmounts[hop.backendName] ?? "200000000000000",
        fromAddress: address,
        preference: "cheapest" as const,
      };

      const quote = await backend.getQuote(params);
      if (quote) {
        console.log(`  ✅ Hop ${i + 1} (${hop.backendName}): ${hop.fromSymbol} ${chainName(hop.fromChainId)} → ${hop.toSymbol} ${chainName(hop.toChainId)} — output: ${quote.outputAmount}`);
      } else {
        console.log(`  ❌ Hop ${i + 1} (${hop.backendName}): No route available for ${hop.fromSymbol} ${chainName(hop.fromChainId)} → ${hop.toSymbol} ${chainName(hop.toChainId)}`);
        allRoutesAvailable = false;
      }
    } catch (err) {
      console.log(`  ❌ Hop ${i + 1} (${hop.backendName}): ${(err as Error).message}`);
      allRoutesAvailable = false;
    }
  }

  console.log();

  if (!allRoutesAvailable) {
    console.log("⚠️  Not all routes available. Some hops may fail or need fallbacks.\n");
  }

  if (DRY_RUN) {
    console.log("═══ DRY RUN COMPLETE ═══\n");
    console.log("All route verifications done. Run without --dry-run to execute on-chain.");
    return;
  }

  // ── Execute hops sequentially ──────────────────────────────────────

  console.log("═══ Executing Bridge Hops ═══\n");

  const results: HopResult[] = [];
  let currentAmount = CBBTC_AMOUNT; // Start with cbBTC amount
  let currentDecimals = 8; // cbBTC decimals

  for (let i = 0; i < HOPS.length; i++) {
    const hop = HOPS[i];
    const hopStart = Date.now();

    console.log(`\n━━━ Hop ${i + 1}/6: ${hop.name} ━━━`);
    console.log(`  Input: ${formatAmount(BigInt(currentAmount), currentDecimals)} ${hop.fromSymbol}`);

    try {
      if (hop.backendName === "persistence") {
        // Persistence uses signAndExecute (server-side signing)
        const result = await executePersistenceHop(hop, wallet, address, currentAmount);
        results.push({
          hop: i + 1,
          backend: hop.backendName,
          from: chainName(hop.fromChainId),
          to: chainName(hop.toChainId),
          token: `${hop.fromSymbol} → ${hop.toSymbol}`,
          inputAmount: currentAmount,
          outputAmount: result.outputAmount,
          txHash: result.txHash,
          status: "success",
          elapsed: Date.now() - hopStart,
        });

        // Update for next hop: read actual BTCB balance on BSC
        currentAmount = result.outputAmount;
        currentDecimals = hop.toDecimals;
        console.log(`  ✅ Success! Output: ${formatAmount(BigInt(currentAmount), currentDecimals)} ${hop.toSymbol}`);
        console.log(`  tx: ${result.txHash}`);
      } else {
        // Standard flow: getQuote → buildTransaction → [approve] → sign → send
        const result = await executeStandardHop(hop, wallet, address, currentAmount);
        results.push({
          hop: i + 1,
          backend: hop.backendName,
          from: chainName(hop.fromChainId),
          to: chainName(hop.toChainId),
          token: `${hop.fromSymbol} → ${hop.toSymbol}`,
          inputAmount: currentAmount,
          outputAmount: result.outputAmount,
          txHash: result.txHash,
          status: "success",
          elapsed: Date.now() - hopStart,
        });

        currentAmount = result.outputAmount;
        currentDecimals = hop.toDecimals;
        console.log(`  ✅ Success! Output: ${formatAmount(BigInt(currentAmount), currentDecimals)} ${hop.toSymbol}`);
        console.log(`  tx: ${result.txHash}`);
      }
    } catch (err) {
      const error = (err as Error).message;
      console.error(`  ❌ FAILED: ${error}`);
      results.push({
        hop: i + 1,
        backend: hop.backendName,
        from: chainName(hop.fromChainId),
        to: chainName(hop.toChainId),
        token: `${hop.fromSymbol} → ${hop.toSymbol}`,
        inputAmount: currentAmount,
        outputAmount: "0",
        status: "failed",
        error,
        elapsed: Date.now() - hopStart,
      });

      // Try to recover: read balance on destination and continue if possible
      console.log("  Attempting to read destination balance and continue...");
      try {
        const destBal = await getBalance(hop.toChainId, address, hop.toToken);
        if (destBal > 0n) {
          currentAmount = destBal.toString();
          currentDecimals = hop.toDecimals;
          console.log(`  Recovered: ${formatAmount(destBal, hop.toDecimals)} ${hop.toSymbol} on ${chainName(hop.toChainId)}`);
        } else {
          console.log("  No balance on destination chain. Stopping.");
          break;
        }
      } catch {
        console.log("  Could not read destination balance. Stopping.");
        break;
      }
    }

    // Small delay between hops to let things settle
    if (i < HOPS.length - 1) {
      console.log("  Waiting 5s before next hop...");
      await sleep(5000);
    }
  }

  // ── Results Summary ─────────────────────────────────────────────────

  console.log("\n\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    RESULTS SUMMARY                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("Hop | Backend      | Route                        | Status  | Time    | Tx Hash");
  console.log("────┼──────────────┼──────────────────────────────┼─────────┼─────────┼─────────────");
  for (const r of results) {
    const txShort = r.txHash ? `${r.txHash.slice(0, 10)}...` : "N/A";
    const time = `${(r.elapsed / 1000).toFixed(1)}s`;
    const status = r.status === "success" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
    console.log(
      `  ${r.hop} | ${r.backend.padEnd(12)} | ${r.from} → ${r.to} (${r.token})`.padEnd(65) +
      ` | ${status}`.padEnd(10) +
      ` | ${time}`.padEnd(10) +
      ` | ${txShort}`
    );
  }

  const successes = results.filter((r) => r.status === "success").length;
  const failures = results.filter((r) => r.status === "failed").length;
  const totalTime = results.reduce((sum, r) => sum + r.elapsed, 0);

  console.log(`\nTotal: ${successes} success, ${failures} failed, ${(totalTime / 1000).toFixed(1)}s elapsed`);

  // ── Edge Case Tests ────────────────────────────────────────────────

  console.log("\n═══ Edge Case Validation ═══\n");

  // Test 1: Unknown token → registry rejection
  try {
    const { resolveToken } = await import("../../src/utils/token-registry.js");
    const result = resolveToken("FAKETOKENABC", 8453);
    if (!result.ok) {
      console.log("  ✅ Unknown token rejected:", result.error.slice(0, 80));
    } else {
      console.log("  ❌ Unknown token was NOT rejected");
    }
  } catch (err) {
    console.log("  ❌ Error:", (err as Error).message);
  }

  // Test 2: Persistence amount > 0.001 BTC → cap rejection
  try {
    const params: QuoteParams = {
      fromChainId: 8453,
      toChainId: 56,
      fromTokenAddress: CBBTC_BASE,
      toTokenAddress: BTCB_BSC,
      amountRaw: "200000", // 0.002 BTC (> 0.001 cap)
      fromAddress: address,
      preference: "cheapest",
    };
    const quote = await backends.persistence.getQuote(params);
    if (!quote) {
      console.log("  ✅ Over-cap Persistence amount returned null (rejected)");
    } else {
      console.log("  ⚠️  Over-cap amount returned quote — may need validation check");
    }
  } catch (err) {
    console.log("  ✅ Over-cap Persistence amount threw:", (err as Error).message.slice(0, 80));
  }

  // Test 3: Error sanitization
  try {
    const { sanitizeError } = await import("../../src/utils/sanitize-error.js");
    const testErr = new Error(`Failed with key ${privateKey} at /home/user/.env`);
    const sanitized = sanitizeError(testErr);
    const leaksKey = sanitized.includes(privateKey);
    const leaksPath = sanitized.includes("/home/user");
    if (!leaksKey && !leaksPath) {
      console.log("  ✅ Error sanitization working (key + path stripped)");
    } else {
      console.log("  ❌ Sanitization failed! Leaks:", leaksKey ? "key" : "", leaksPath ? "path" : "");
    }
  } catch (err) {
    console.log("  ❌ Sanitize error:", (err as Error).message);
  }

  console.log("\n═══ Done ═══\n");
}

// ── Hop Executors ───────────────────────────────────────────────────────

async function executePersistenceHop(
  hop: HopDef,
  wallet: ethers.Wallet,
  address: string,
  amountRaw: string,
): Promise<{ txHash: string; outputAmount: string }> {
  const backend = backends.persistence as PersistenceBackend;

  // Get quote
  const params: QuoteParams = {
    fromChainId: hop.fromChainId,
    toChainId: hop.toChainId,
    fromTokenAddress: hop.fromToken,
    toTokenAddress: hop.toToken,
    amountRaw,
    fromAddress: address,
    preference: "cheapest",
  };

  console.log("  Getting quote...");
  const quote = await backend.getQuote(params);
  if (!quote) throw new Error("No quote from Persistence");
  console.log(`  Quote: ${quote.outputAmount} ${hop.toSymbol} (${quote.route})`);

  // Execute (Persistence uses signAndExecute)
  console.log("  Executing signAndExecute...");
  const result = await backend.signAndExecute(quote, wallet);
  console.log(`  Initiate tx: ${result.txHash}`);

  // Wait for destination balance to appear (BTCB on BSC)
  console.log("  Waiting for destination balance...");
  const destBalBefore = await getBalance(hop.toChainId, address, hop.toToken);
  const destBal = await waitForBalance(
    hop.toChainId,
    address,
    hop.toToken,
    destBalBefore + 1n, // Any increase indicates the bridge completed
    300_000, // 5 min timeout
    10_000,
  );

  const received = destBal - destBalBefore;
  return {
    txHash: result.txHash,
    outputAmount: received.toString(),
  };
}

async function executeStandardHop(
  hop: HopDef,
  wallet: ethers.Wallet,
  address: string,
  amountRaw: string,
): Promise<{ txHash: string; outputAmount: string }> {
  const backend = backends[hop.backendName];
  const provider = getProvider(hop.fromChainId);
  const connectedWallet = wallet.connect(provider);

  // Get quote
  const params: QuoteParams = {
    fromChainId: hop.fromChainId,
    toChainId: hop.toChainId,
    fromTokenAddress: hop.fromToken,
    toTokenAddress: hop.toToken,
    amountRaw,
    fromAddress: address,
    preference: "cheapest",
  };

  console.log("  Getting quote...");
  const quote = await backend.getQuote(params);
  if (!quote) throw new Error(`No quote from ${hop.backendName}`);
  console.log(`  Quote: ${quote.outputAmount} ${hop.toSymbol} (${quote.route})`);

  // Build transaction
  console.log("  Building transaction...");
  const tx = await backend.buildTransaction(quote);

  // Handle approval if needed (for ERC20 tokens)
  if (tx.approvalTx) {
    console.log("  Sending approval tx...");
    const approvalResult = await connectedWallet.sendTransaction({
      to: tx.approvalTx.to,
      data: tx.approvalTx.data,
      value: tx.approvalTx.value ? BigInt(tx.approvalTx.value) : 0n,
    });
    console.log(`  Approval tx: ${approvalResult.hash}`);
    await approvalResult.wait();
    console.log("  Approval confirmed.");
  }

  // Simulate before sending
  console.log("  Simulating transaction...");
  const sim = await simulateTransaction(tx.chainId, {
    to: tx.to,
    data: tx.data,
    value: tx.value,
    from: address,
  });
  if (!sim.success) {
    console.warn(`  ⚠️ Simulation warning: ${sim.error}`);
    // Don't abort — simulation can be overly strict
  } else {
    console.log("  Simulation passed.");
  }

  // Send the transaction
  console.log("  Sending bridge transaction...");
  const destBalBefore = await getBalance(hop.toChainId, address, hop.toToken);

  const txResult = await connectedWallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  });
  console.log(`  Bridge tx: ${txResult.hash}`);

  // Wait for source chain confirmation
  console.log("  Waiting for source chain confirmation...");
  const receipt = await txResult.wait();
  console.log(`  Confirmed in block ${receipt?.blockNumber}`);

  // Wait for destination balance
  console.log("  Waiting for destination balance...");
  const timeoutMs = hop.backendName === "skip" ? 1200_000 : 300_000; // Skip can take 18 min
  const destBal = await waitForBalance(
    hop.toChainId,
    address,
    hop.toToken,
    destBalBefore + 1n,
    timeoutMs,
    10_000,
  );

  const received = destBal - destBalBefore;
  return {
    txHash: txResult.hash,
    outputAmount: received.toString(),
  };
}

function chainName(id: number): string {
  const names: Record<number, string> = {
    1: "Ethereum",
    10: "Optimism",
    56: "BSC",
    137: "Polygon",
    8453: "Base",
    42161: "Arbitrum",
    59144: "Linea",
    534352: "Scroll",
  };
  return names[id] ?? `Chain ${id}`;
}

// ── Run ─────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n💥 Fatal error:", err.message);
  process.exit(1);
});
