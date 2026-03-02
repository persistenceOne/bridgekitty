#!/usr/bin/env tsx
/**
 * BridgeKitty — Continue daisy chain: Hops 4-6 (deBridge, Across, Relay)
 *
 * Picks up from where the main test left off. Uses USDC on Base.
 *
 * Route:
 *   USDC (Base) ──── deBridge ──→ ETH (Linea)
 *   ETH (Linea) ──── Across ───→ ETH (Scroll)
 *   ETH (Scroll) ─── Relay ────→ ETH (Base)
 *
 * Usage:
 *   npx tsx tests/live/continue-hops-4-6.ts [--dry-run]
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { DeBridgeBackend } from "../../src/backends/debridge.js";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";
import type { QuoteParams } from "../../src/backends/types.js";
import { simulateTransaction } from "../../src/utils/tx-simulator.js";

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
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function getProvider(chainId: number): ethers.JsonRpcProvider {
  const rpc = RPCS[chainId];
  if (!rpc) throw new Error(`No RPC for chain ${chainId}`);
  return new ethers.JsonRpcProvider(rpc);
}

async function getBalance(chainId: number, address: string, tokenAddress: string): Promise<bigint> {
  const provider = getProvider(chainId);
  if (tokenAddress === NATIVE) return provider.getBalance(address);
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
  chainId: number, address: string, tokenAddress: string,
  minBalance: bigint, timeoutMs = 600_000, pollMs = 10_000,
): Promise<bigint> {
  const start = Date.now();
  const decimals = tokenAddress === NATIVE ? 18 : 6;
  while (Date.now() - start < timeoutMs) {
    const bal = await getBalance(chainId, address, tokenAddress);
    if (bal >= minBalance) return bal;
    console.log(`  ... waiting for balance (have: ${formatAmount(bal, decimals)}, need: ${formatAmount(minBalance, decimals)})`);
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for balance on chain ${chainId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chainName: Record<number, string> = {
  8453: "Base", 59144: "Linea", 534352: "Scroll",
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  BridgeKitty — Hops 4-6 (deBridge, Across, Relay)   ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  if (DRY_RUN) console.log("🏜️  DRY RUN MODE\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("❌ PRIVATE_KEY not found"); process.exit(1); }

  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  console.log(`Wallet: ${address}\n`);

  const debridge = new DeBridgeBackend();
  const across = new AcrossBackend();
  const relay = new RelayBackend();

  // ── Check starting balance ────────────────────────────────────────
  const usdcBal = await getBalance(8453, address, USDC_BASE);
  const ethBal = await getBalance(8453, address, NATIVE);
  console.log(`Base USDC: ${formatAmount(usdcBal, 6)}`);
  console.log(`Base ETH: ${formatAmount(ethBal, 18)}\n`);

  // Use 2 USDC for the deBridge hop
  const DEBRIDGE_AMOUNT = "2000000"; // 2 USDC (6 decimals)

  // ── Hop 4: deBridge — USDC Base → ETH Linea ──────────────────────
  console.log("━━━ Hop 4/6: deBridge — USDC Base → ETH Linea ━━━");
  console.log(`  Input: 2.000000 USDC`);

  const debridgeQuote = await debridge.getQuote({
    fromChainId: 8453,
    toChainId: 59144,
    fromTokenAddress: USDC_BASE,
    toTokenAddress: NATIVE,
    amountRaw: DEBRIDGE_AMOUNT,
    fromAddress: address,
    preference: "cheapest",
  });

  if (!debridgeQuote) throw new Error("No deBridge quote");
  console.log(`  Quote: ${debridgeQuote.outputAmount} ETH (${debridgeQuote.route})`);

  if (DRY_RUN) {
    console.log("  ✅ Dry run: quote OK\n");
  } else {
    const debridgeTx = await debridge.buildTransaction(debridgeQuote);
    console.log(`  Built tx → to: ${debridgeTx.to}`);

    // Handle approval
    if (debridgeTx.approvalTx) {
      console.log("  Sending approval tx...");
      const provider = getProvider(8453);
      const w = wallet.connect(provider);
      const appTx = await w.sendTransaction({
        to: debridgeTx.approvalTx.to,
        data: debridgeTx.approvalTx.data,
        value: 0n,
      });
      console.log(`  Approval: ${appTx.hash}`);
      await appTx.wait();
      console.log("  Approval confirmed.");

      // Small delay for RPC propagation
      await sleep(2000);
    }

    // Simulate
    console.log("  Simulating...");
    const sim = await simulateTransaction(debridgeTx.chainId, {
      to: debridgeTx.to, data: debridgeTx.data, value: debridgeTx.value, from: address,
    });
    if (!sim.success) console.warn(`  ⚠️ Simulation: ${sim.error}`);
    else if (sim.warning) console.log(`  ⚠️ ${sim.warning}`);
    else console.log("  Simulation passed.");

    // Record destination balance before
    const lineaEthBefore = await getBalance(59144, address, NATIVE);

    // Send
    console.log("  Sending bridge tx...");
    const provider = getProvider(8453);
    const w = wallet.connect(provider);
    const txResult = await w.sendTransaction({
      to: debridgeTx.to,
      data: debridgeTx.data,
      value: debridgeTx.value ? BigInt(debridgeTx.value) : 0n,
    });
    console.log(`  Tx: ${txResult.hash}`);
    const receipt = await txResult.wait();
    console.log(`  Confirmed in block ${receipt?.blockNumber}`);

    // Wait for ETH on Linea
    console.log("  Waiting for ETH on Linea...");
    const lineaEth = await waitForBalance(59144, address, NATIVE, lineaEthBefore + 1n, 300_000);
    const received = lineaEth - lineaEthBefore;
    console.log(`  ✅ Received: ${formatAmount(received, 18)} ETH on Linea\n`);

    // ── Hop 5: Across — ETH Linea → ETH Scroll ─────────────────────
    console.log("━━━ Hop 5/6: Across — ETH Linea → ETH Scroll ━━━");

    // Use 80% of received ETH (keep some for gas)
    const acrossInputRaw = (received * 80n / 100n).toString();
    console.log(`  Input: ${formatAmount(BigInt(acrossInputRaw), 18)} ETH`);

    const acrossQuote = await across.getQuote({
      fromChainId: 59144,
      toChainId: 534352,
      fromTokenAddress: NATIVE,
      toTokenAddress: NATIVE,
      amountRaw: acrossInputRaw,
      fromAddress: address,
      preference: "cheapest",
    });

    if (!acrossQuote) {
      console.log("  ❌ No Across quote (amount may be too small). Trying Relay instead...");
      // Fallback: use Relay for this hop
      const relayQuote5 = await relay.getQuote({
        fromChainId: 59144,
        toChainId: 534352,
        fromTokenAddress: NATIVE,
        toTokenAddress: NATIVE,
        amountRaw: acrossInputRaw,
        fromAddress: address,
        preference: "cheapest",
      });

      if (!relayQuote5) throw new Error("No quote for Linea→Scroll from any backend");
      console.log(`  Fallback Quote (Relay): ${relayQuote5.outputAmount} ETH`);

      const relayTx5 = await relay.buildTransaction(relayQuote5);
      const scrollEthBefore = await getBalance(534352, address, NATIVE);

      console.log("  Sending bridge tx...");
      const w5 = wallet.connect(getProvider(59144));
      const txResult5 = await w5.sendTransaction({
        to: relayTx5.to, data: relayTx5.data,
        value: relayTx5.value ? BigInt(relayTx5.value) : 0n,
      });
      console.log(`  Tx: ${txResult5.hash}`);
      await txResult5.wait();

      console.log("  Waiting for ETH on Scroll...");
      const scrollEth = await waitForBalance(534352, address, NATIVE, scrollEthBefore + 1n, 300_000);
      const scrollReceived = scrollEth - scrollEthBefore;
      console.log(`  ✅ Received: ${formatAmount(scrollReceived, 18)} ETH on Scroll\n`);

      // Skip to hop 6 with Across
      console.log("━━━ Hop 6/6: Across — ETH Scroll → ETH Base ━━━");
      const hop6InputRaw = (scrollReceived * 80n / 100n).toString();
      console.log(`  Input: ${formatAmount(BigInt(hop6InputRaw), 18)} ETH`);

      const acrossQuote6 = await across.getQuote({
        fromChainId: 534352, toChainId: 8453,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: hop6InputRaw, fromAddress: address, preference: "cheapest",
      });
      if (!acrossQuote6) throw new Error("No Across quote for Scroll→Base");

      const acrossTx6 = await across.buildTransaction(acrossQuote6);
      const baseEthBefore = await getBalance(8453, address, NATIVE);

      const w6 = wallet.connect(getProvider(534352));
      const txResult6 = await w6.sendTransaction({
        to: acrossTx6.to, data: acrossTx6.data,
        value: acrossTx6.value ? BigInt(acrossTx6.value) : 0n,
      });
      console.log(`  Tx: ${txResult6.hash}`);
      await txResult6.wait();

      console.log("  Waiting for ETH on Base...");
      const baseEth = await waitForBalance(8453, address, NATIVE, baseEthBefore + 1n, 300_000);
      console.log(`  ✅ Received: ${formatAmount(baseEth - baseEthBefore, 18)} ETH on Base\n`);
      console.log("═══ All 3 remaining hops complete! ═══");
      return;
    }

    console.log(`  Quote: ${acrossQuote.outputAmount} ETH (${acrossQuote.route})`);

    const acrossTx = await across.buildTransaction(acrossQuote);
    const scrollEthBefore = await getBalance(534352, address, NATIVE);

    console.log("  Sending bridge tx...");
    const w5 = wallet.connect(getProvider(59144));
    const txResult5 = await w5.sendTransaction({
      to: acrossTx.to, data: acrossTx.data,
      value: acrossTx.value ? BigInt(acrossTx.value) : 0n,
    });
    console.log(`  Tx: ${txResult5.hash}`);
    await txResult5.wait();

    console.log("  Waiting for ETH on Scroll...");
    const scrollEth = await waitForBalance(534352, address, NATIVE, scrollEthBefore + 1n, 300_000);
    const scrollReceived = scrollEth - scrollEthBefore;
    console.log(`  ✅ Received: ${formatAmount(scrollReceived, 18)} ETH on Scroll\n`);

    // ── Hop 6: Relay — ETH Scroll → ETH Base ───────────────────────
    console.log("━━━ Hop 6/6: Relay — ETH Scroll → ETH Base ━━━");
    const relayInputRaw = (scrollReceived * 80n / 100n).toString();
    console.log(`  Input: ${formatAmount(BigInt(relayInputRaw), 18)} ETH`);

    const relayQuote = await relay.getQuote({
      fromChainId: 534352,
      toChainId: 8453,
      fromTokenAddress: NATIVE,
      toTokenAddress: NATIVE,
      amountRaw: relayInputRaw,
      fromAddress: address,
      preference: "cheapest",
    });

    if (!relayQuote) throw new Error("No Relay quote for Scroll→Base");
    console.log(`  Quote: ${relayQuote.outputAmount} ETH (${relayQuote.route})`);

    const relayTx = await relay.buildTransaction(relayQuote);
    const baseEthBefore = await getBalance(8453, address, NATIVE);

    console.log("  Sending bridge tx...");
    const w6 = wallet.connect(getProvider(534352));
    const txResult6 = await w6.sendTransaction({
      to: relayTx.to, data: relayTx.data,
      value: relayTx.value ? BigInt(relayTx.value) : 0n,
    });
    console.log(`  Tx: ${txResult6.hash}`);
    await txResult6.wait();

    console.log("  Waiting for ETH on Base...");
    const baseEth = await waitForBalance(8453, address, NATIVE, baseEthBefore + 1n, 300_000);
    console.log(`  ✅ Received: ${formatAmount(baseEth - baseEthBefore, 18)} ETH on Base\n`);

    console.log("═══ All 3 remaining hops complete! ═══");
  }

  // Dry run for all 3
  if (DRY_RUN) {
    console.log("━━━ Hop 5/6: Across — ETH Linea → ETH Scroll ━━━");
    const acrossQuote = await across.getQuote({
      fromChainId: 59144, toChainId: 534352,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: "1000000000000000", // 0.001 ETH
      fromAddress: address, preference: "cheapest",
    });
    if (acrossQuote) console.log(`  ✅ Dry run: ${acrossQuote.outputAmount} ETH\n`);
    else console.log("  ⚠️ No Across quote (amount too small)\n");

    console.log("━━━ Hop 6/6: Relay — ETH Scroll → ETH Base ━━━");
    const relayQuote = await relay.getQuote({
      fromChainId: 534352, toChainId: 8453,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: "1000000000000000", // 0.001 ETH
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
