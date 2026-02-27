// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Full E2E test: Bridge cbBTC (Base) → BTCB (BSC) via Persistence Interop
 * Uses the complete EIP-712 Permit2 + witness signing flow.
 *
 * Usage: npx tsx scripts/test-persistence-e2e.ts
 * Requires: TEST_BUYER_PRIVATE_KEY in .env.acp
 */

import { ethers } from "ethers";
import { PersistenceBackend } from "../src/backends/persistence.js";

// Load env
import { readFileSync } from "fs";
const envFile = readFileSync(".env.acp", "utf8");
for (const line of envFile.split("\n")) {
  const [key, ...val] = line.split("=");
  if (key && val.length) process.env[key.trim()] = val.join("=").trim();
}

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BASE_RPC = "https://mainnet.base.org";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Persistence Interop E2E Test: cbBTC (Base) → BTCB (BSC)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, baseProvider);

  // Check balance
  const cbbtc = new ethers.Contract(CBBTC_BASE, ERC20_ABI, baseProvider);
  const balance = await cbbtc.balanceOf(WALLET);
  console.log(`cbBTC balance: ${ethers.formatUnits(balance, 8)} (${balance} raw)`);

  if (balance === 0n) {
    console.log("❌ No cbBTC balance. Cannot proceed.");
    process.exit(1);
  }

  // Use most of the balance but leave a tiny dust
  // We have ~0.00014597 cbBTC = 14597 raw (8 decimals)
  // Min is 5000 raw. Use 10000 raw = 0.0001 BTC
  const bridgeAmount = "5500"; // 0.000055 BTC in 8-decimal raw (just above 5000 minimum)

  if (balance < BigInt(bridgeAmount)) {
    console.log(`❌ Insufficient balance. Need ${bridgeAmount} raw, have ${balance}`);
    process.exit(1);
  }

  const persistence = new PersistenceBackend();

  // Step 1: Get quote
  console.log("\n── Step 1: Get quote ──────────────────────────────────────");
  const quote = await persistence.getQuote({
    fromChainId: 8453,
    toChainId: 56,
    fromTokenAddress: CBBTC_BASE,
    toTokenAddress: BTCB_BSC,
    amountRaw: bridgeAmount,
    fromAddress: WALLET,
    toAddress: WALLET,
    preference: "cheapest",
  });

  if (!quote) {
    console.log("❌ No quote available.");
    process.exit(1);
  }

  console.log(`✅ Quote received:`);
  console.log(`   Output: ${quote.outputAmount} BTCB`);
  console.log(`   Min output: ${quote.minOutputAmount} BTCB`);
  console.log(`   Route: ${quote.route}`);
  console.log(`   Est time: ${quote.estimatedTimeSeconds}s`);

  // Step 2: Sign and execute the full flow
  console.log("\n── Step 2: Sign & Execute (EIP-712 flow) ─────────────────");
  const result = await persistence.signAndExecute(quote, wallet);

  console.log(`\n✅ Bridge initiated!`);
  console.log(`   TX Hash: ${result.txHash}`);
  console.log(`   Order ID: ${result.orderId}`);
  console.log(`   Tracking: ${result.trackingId}`);

  // Step 3: Poll status
  console.log("\n── Step 3: Poll status ───────────────────────────────────");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = await persistence.getStatus(result.trackingId, {
      orderId: result.orderId,
    });
    console.log(`[${new Date().toISOString()}] Status: ${status.state} — ${status.humanReadable}`);
    if (status.state === "completed") {
      console.log(`\n🎉 Bridge completed! Dest TX: ${status.destTxHash}`);
      return;
    }
    if (status.state === "failed") {
      console.log(`\n❌ Bridge failed: ${status.humanReadable}`);
      process.exit(1);
    }
  }

  console.log("\n⏰ Timed out waiting for completion (5 min). Check manually.");
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
