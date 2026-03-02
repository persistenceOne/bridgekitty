#!/usr/bin/env tsx
/**
 * BridgeKitty — Continue daisy chain: Hops 5-6 (Across, Relay)
 *
 * Uses ETH on Linea from the deBridge hop.
 *
 * Route:
 *   ETH (Linea) ──── Across ───→ ETH (Scroll)
 *   ETH (Scroll) ─── Relay ────→ ETH (Base)
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";

// Load .env manually
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

const DRY_RUN = process.argv.includes("--dry-run");
const NATIVE = "0x0000000000000000000000000000000000000000";

const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

function getProvider(chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPCS[chainId]);
}

function formatEth(raw: bigint): string {
  return ethers.formatEther(raw);
}

async function waitForBalance(
  chainId: number, address: string,
  minBalance: bigint, timeoutMs = 300_000, pollMs = 10_000,
): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await getProvider(chainId).getBalance(address);
    if (bal >= minBalance) return bal;
    console.log(`  ... waiting (have: ${formatEth(bal)} ETH)`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout waiting for balance on chain ${chainId}`);
}

async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  BridgeKitty — Hops 5-6 (Across+Relay) ║");
  console.log("╚═══════════════════════════════════════╝\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("❌ PRIVATE_KEY not found"); process.exit(1); }

  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  console.log(`Wallet: ${address}\n`);

  const across = new AcrossBackend();
  const relay = new RelayBackend();

  // Check Linea balance
  const lineaBal = await getProvider(59144).getBalance(address);
  console.log(`Linea ETH: ${formatEth(lineaBal)}`);

  // Use 75% of balance (keep some for gas)
  const acrossInput = lineaBal * 75n / 100n;
  console.log(`Using: ${formatEth(acrossInput)} ETH for Across\n`);

  // ── Hop 5: Across — ETH Linea → ETH Scroll ─────────────────────
  console.log("━━━ Hop 5: Across — ETH Linea → ETH Scroll ━━━");

  const acrossQuote = await across.getQuote({
    fromChainId: 59144,
    toChainId: 534352,
    fromTokenAddress: NATIVE,
    toTokenAddress: NATIVE,
    amountRaw: acrossInput.toString(),
    fromAddress: address,
    preference: "cheapest",
  });

  if (!acrossQuote) throw new Error("No Across quote");
  console.log(`  Quote: ${acrossQuote.outputAmount} ETH (${acrossQuote.route})`);
  console.log(`  Fee: ${acrossQuote.estimatedFeeUsd ? '$' + acrossQuote.estimatedFeeUsd : 'N/A'}`);

  if (DRY_RUN) {
    console.log("  ✅ Dry run OK\n");
  } else {
    const acrossTx = await across.buildTransaction(acrossQuote);
    console.log(`  SpokePool: ${acrossTx.to}`);
    console.log(`  Value: ${acrossTx.value}`);

    const scrollBefore = await getProvider(534352).getBalance(address);

    console.log("  Sending bridge tx...");
    const w = wallet.connect(getProvider(59144));
    const txResult = await w.sendTransaction({
      to: acrossTx.to,
      data: acrossTx.data,
      value: acrossTx.value ? BigInt(acrossTx.value) : 0n,
    });
    console.log(`  Tx: ${txResult.hash}`);
    const receipt = await txResult.wait();
    console.log(`  Confirmed in block ${receipt?.blockNumber}`);

    console.log("  Waiting for ETH on Scroll...");
    const scrollBal = await waitForBalance(534352, address, scrollBefore + 1n);
    const scrollReceived = scrollBal - scrollBefore;
    console.log(`  ✅ Received: ${formatEth(scrollReceived)} ETH on Scroll\n`);

    // ── Hop 6: Relay — ETH Scroll → ETH Base ───────────────────────
    console.log("━━━ Hop 6: Relay — ETH Scroll → ETH Base ━━━");

    // Use 75% of received (keep gas)
    const relayInput = scrollReceived * 75n / 100n;
    console.log(`  Using: ${formatEth(relayInput)} ETH`);

    const relayQuote = await relay.getQuote({
      fromChainId: 534352,
      toChainId: 8453,
      fromTokenAddress: NATIVE,
      toTokenAddress: NATIVE,
      amountRaw: relayInput.toString(),
      fromAddress: address,
      preference: "cheapest",
    });

    if (!relayQuote) throw new Error("No Relay quote");
    console.log(`  Quote: ${relayQuote.outputAmount} ETH (${relayQuote.route})`);

    const relayTx = await relay.buildTransaction(relayQuote);
    const baseBefore = await getProvider(8453).getBalance(address);

    console.log("  Sending bridge tx...");
    const w6 = wallet.connect(getProvider(534352));
    const txResult6 = await w6.sendTransaction({
      to: relayTx.to,
      data: relayTx.data,
      value: relayTx.value ? BigInt(relayTx.value) : 0n,
    });
    console.log(`  Tx: ${txResult6.hash}`);
    const receipt6 = await txResult6.wait();
    console.log(`  Confirmed in block ${receipt6?.blockNumber}`);

    console.log("  Waiting for ETH on Base...");
    const baseBal = await waitForBalance(8453, address, baseBefore + 1n);
    const baseReceived = baseBal - baseBefore;
    console.log(`  ✅ Received: ${formatEth(baseReceived)} ETH on Base\n`);

    console.log("═══ Hops 5+6 COMPLETE! Full loop closed. ═══");
  }

  // Dry run for hop 6
  if (DRY_RUN) {
    console.log("━━━ Hop 6: Relay — ETH Scroll → ETH Base ━━━");
    const relayQuote = await relay.getQuote({
      fromChainId: 534352, toChainId: 8453,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: "500000000000000", // 0.0005 ETH
      fromAddress: address, preference: "cheapest",
    });
    if (relayQuote) console.log(`  ✅ Dry run: ${relayQuote.outputAmount} ETH\n`);
    else console.log("  ⚠️ No Relay quote\n");
    console.log("═══ DRY RUN COMPLETE ═══");
  }
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
