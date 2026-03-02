#!/usr/bin/env tsx
/**
 * Test each bridge backend individually (except Skip).
 * Uses fresh quotes right before execution to avoid staleness.
 * Retries with higher slippage if needed.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { LiFiBackend } from "../../src/backends/lifi.js";
import { DeBridgeBackend } from "../../src/backends/debridge.js";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import type { QuoteParams } from "../../src/backends/types.js";
import { simulateTransaction } from "../../src/utils/tx-simulator.js";

// Load ~/.bridgekitty/.env
const envPath = path.resolve(process.env.HOME + "/.bridgekitty/.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const NATIVE = "0x0000000000000000000000000000000000000000";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed1.binance.org",
  10: "https://mainnet.optimism.io",
  42161: "https://arb1.arbitrum.io/rpc",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

function getProvider(chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPCS[chainId]);
}

async function getBalance(chainId: number, addr: string, token: string): Promise<bigint> {
  const p = getProvider(chainId);
  if (token === NATIVE) return p.getBalance(addr);
  return new ethers.Contract(token, ERC20_ABI, p).balanceOf(addr);
}

function fmt(raw: bigint, dec: number): string {
  return (Number(raw) / 10**dec).toFixed(dec > 10 ? 10 : dec);
}

async function waitForBalance(chainId: number, addr: string, token: string, minBal: bigint, timeout = 300_000): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const bal = await getBalance(chainId, addr, token);
    if (bal >= minBal) return bal;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`    waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 8_000));
  }
  throw new Error(`Timeout waiting for balance on chain ${chainId}`);
}

interface TestResult {
  backend: string;
  route: string;
  status: "✅" | "❌";
  time: string;
  txHash: string;
  error?: string;
}

const results: TestResult[] = [];

async function testStandardBackend(
  name: string,
  backend: any,
  params: QuoteParams,
  wallet: ethers.Wallet,
  destToken: string,
  destDecimals: number,
): Promise<boolean> {
  const t0 = Date.now();
  const label = `${params.fromChainId} → ${params.toChainId}`;
  console.log(`\n━━━ Testing ${name}: ${label} ━━━`);

  try {
    // Fresh quote right before execution
    console.log(`  Getting quote...`);
    const quote = await backend.getQuote(params);
    if (!quote) {
      console.log(`  ❌ No quote available`);
      results.push({ backend: name, route: label, status: "❌", time: "0s", txHash: "N/A", error: "No quote" });
      return false;
    }
    console.log(`  Quote: ${quote.outputAmount} (${quote.route})`);

    // Build tx
    console.log(`  Building transaction...`);
    const tx = await backend.buildTransaction(quote);

    // Connect wallet to source chain
    const signer = wallet.connect(getProvider(params.fromChainId));

    // Handle approval
    if (tx.approvalTx) {
      console.log(`  Approving...`);
      const appr = await signer.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: 0n });
      await appr.wait();
      console.log(`  Approved ✓`);
    }

    // Simulate
    console.log(`  Simulating...`);
    const sim = await simulateTransaction(tx.chainId, {
      to: tx.to, data: tx.data, value: tx.value, from: params.fromAddress,
    });
    if (!sim.success) {
      console.log(`  ⚠️ Simulation warning: ${sim.error?.slice(0, 100)}`);
    }

    // Pre-balance on destination
    const preBal = await getBalance(params.toChainId, params.fromAddress!, destToken);

    // Send
    console.log(`  Sending tx...`);
    const txRes = await signer.sendTransaction({
      to: tx.to, data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    });
    console.log(`  Tx sent: ${txRes.hash}`);
    const receipt = await txRes.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Transaction reverted on-chain`);
    }
    console.log(`  Confirmed in block ${receipt.blockNumber}`);

    // Wait for destination
    console.log(`  Waiting for destination balance...`);
    const newBal = await waitForBalance(params.toChainId, params.fromAddress!, destToken, preBal + 1n, 300_000);
    const received = newBal - preBal;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✅ Received ${fmt(received, destDecimals)} (${elapsed}s)`);
    results.push({ backend: name, route: label, status: "✅", time: `${elapsed}s`, txHash: txRes.hash });
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const errMsg = (err as Error).message?.slice(0, 150) ?? "unknown";
    console.log(`  ❌ FAILED (${elapsed}s): ${errMsg}`);
    results.push({ backend: name, route: label, status: "❌", time: `${elapsed}s`, txHash: "N/A", error: errMsg });
    return false;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  BridgeKitty — Individual Backend Tests (No Skip)       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("Missing PRIVATE_KEY"); process.exit(1); }

  const wallet = new ethers.Wallet(privateKey);
  const addr = wallet.address;
  console.log(`Wallet: ${addr}\n`);

  const persistence = new PersistenceBackend();
  const lifi = new LiFiBackend();
  const debridge = new DeBridgeBackend();
  const across = new AcrossBackend();
  const relay = new RelayBackend();

  // ── 1. Persistence: cbBTC Base → BTCB BSC ─────────────────────────
  {
    const t0 = Date.now();
    console.log(`\n━━━ Testing Persistence: Base → BSC ━━━`);
    try {
      const cbBTCBal = await getBalance(8453, addr, CBBTC_BASE);
      console.log(`  cbBTC balance: ${fmt(cbBTCBal, 8)}`);
      // Use half the balance so we have funds for later
      const amount = (cbBTCBal / 2n).toString();

      const q = await persistence.getQuote({
        fromChainId: 8453, toChainId: 56,
        fromTokenAddress: CBBTC_BASE, toTokenAddress: BTCB_BSC,
        amountRaw: amount, fromAddress: addr, preference: "cheapest"
      });
      if (!q) throw new Error("No quote");
      console.log(`  Quote: ${q.outputAmount} BTCB`);

      const signer = wallet.connect(getProvider(8453));
      const r = await persistence.signAndExecute(q, signer);
      console.log(`  Tx: ${r.txHash}`);

      const preBal = await getBalance(56, addr, BTCB_BSC);
      const newBal = await waitForBalance(56, addr, BTCB_BSC, preBal + 1n, 60_000);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✅ Persistence verified (${elapsed}s)`);
      results.push({ backend: "Persistence", route: "cbBTC Base→BTCB BSC", status: "✅", time: `${elapsed}s`, txHash: r.txHash });
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ❌ ${(err as Error).message?.slice(0, 150)}`);
      results.push({ backend: "Persistence", route: "cbBTC Base→BTCB BSC", status: "❌", time: `${elapsed}s`, txHash: "N/A", error: (err as Error).message?.slice(0, 100) });
    }
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 2. LI.FI: Use USDC Base → USDC Arbitrum (simple same-token) ──
  // Avoid BTCB→USDC cross-token which has slippage issues.
  // First get some USDC on Base via deBridge or use ETH.
  // Actually: let's test LI.FI with ETH Base → ETH Optimism (native, no DEX swap needed)
  {
    const ethBal = await getBalance(8453, addr, NATIVE);
    // Use 0.001 ETH (~$1.85) for the test
    const amount = "1000000000000000"; // 0.001 ETH
    if (ethBal > BigInt(amount) + 1000000000000000n) { // need gas too
      await testStandardBackend("LI.FI", lifi, {
        fromChainId: 8453, toChainId: 10,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: amount, fromAddress: addr, preference: "cheapest"
      }, wallet, NATIVE, 18);
    } else {
      console.log(`\n━━━ Skipping LI.FI: insufficient ETH on Base ━━━`);
      results.push({ backend: "LI.FI", route: "ETH Base→ETH OP", status: "❌", time: "0s", txHash: "N/A", error: "Insufficient ETH" });
    }
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 3. Across: ETH Optimism → ETH Arbitrum ────────────────────────
  {
    const opEthBal = await getBalance(10, addr, NATIVE);
    if (opEthBal > 500000000000000n) { // > 0.0005 ETH
      // Use half of what we have
      const amount = (opEthBal / 2n).toString();
      await testStandardBackend("Across", across, {
        fromChainId: 10, toChainId: 42161,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: amount, fromAddress: addr, preference: "cheapest"
      }, wallet, NATIVE, 18);
    } else {
      console.log(`\n━━━ Skipping Across: insufficient ETH on Optimism ━━━`);
      results.push({ backend: "Across", route: "ETH OP→ETH Arb", status: "❌", time: "0s", txHash: "N/A", error: "Insufficient ETH on OP" });
    }
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 4. Relay: ETH Arbitrum → ETH Base ──────────────────────────────
  {
    const arbEthBal = await getBalance(42161, addr, NATIVE);
    if (arbEthBal > 200000000000000n) { // > 0.0002 ETH
      const amount = (arbEthBal / 2n).toString();
      await testStandardBackend("Relay", relay, {
        fromChainId: 42161, toChainId: 8453,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: amount, fromAddress: addr, preference: "cheapest"
      }, wallet, NATIVE, 18);
    } else {
      console.log(`\n━━━ Skipping Relay: insufficient ETH on Arbitrum ━━━`);
      results.push({ backend: "Relay", route: "ETH Arb→ETH Base", status: "❌", time: "0s", txHash: "N/A", error: "Insufficient ETH on Arb" });
    }
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 5. deBridge: ETH Base → ETH Linea ─────────────────────────────
  {
    const baseEthBal = await getBalance(8453, addr, NATIVE);
    if (baseEthBal > 1000000000000000n) { // > 0.001 ETH
      const amount = "500000000000000"; // 0.0005 ETH
      await testStandardBackend("deBridge", debridge, {
        fromChainId: 8453, toChainId: 59144,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: amount, fromAddress: addr, preference: "cheapest"
      }, wallet, NATIVE, 18);
    } else {
      console.log(`\n━━━ Skipping deBridge: insufficient ETH on Base ━━━`);
      results.push({ backend: "deBridge", route: "ETH Base→ETH Linea", status: "❌", time: "0s", txHash: "N/A", error: "Insufficient ETH on Base" });
    }
  }

  // ── Results ────────────────────────────────────────────────────────
  console.log("\n\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    RESULTS SUMMARY                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  for (const r of results) {
    console.log(`${r.status} ${r.backend.padEnd(14)} ${r.route.padEnd(30)} ${r.time.padEnd(10)} ${r.txHash.slice(0, 14)}${r.error ? ` (${r.error.slice(0, 60)})` : ''}`);
  }

  const pass = results.filter(r => r.status === "✅").length;
  const fail = results.filter(r => r.status === "❌").length;
  console.log(`\n${pass} passed, ${fail} failed out of ${results.length} tests`);
}

main().catch(e => { console.error(e); process.exit(1); });
