#!/usr/bin/env tsx
/**
 * Test remaining backends: LI.FI, Across, Relay
 * Strategy: Base ETH → OP (LI.FI) → Arb (Across) → Base (Relay)
 * If LI.FI fails, use Across Base→OP as fallback
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { LiFiBackend } from "../../src/backends/lifi.js";
import { AcrossBackend } from "../../src/backends/across.js";
import { RelayBackend } from "../../src/backends/relay.js";
import type { QuoteParams } from "../../src/backends/types.js";
import { simulateTransaction } from "../../src/utils/tx-simulator.js";

const envPath = path.resolve(process.env.HOME + "/.bridgekitty/.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const NATIVE = "0x0000000000000000000000000000000000000000";
const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  10: "https://mainnet.optimism.io",
  42161: "https://arb1.arbitrum.io/rpc",
};

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

function getProvider(chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPCS[chainId]);
}

async function getEthBalance(chainId: number, addr: string): Promise<bigint> {
  return getProvider(chainId).getBalance(addr);
}

async function waitForEth(chainId: number, addr: string, minBal: bigint, timeout = 300_000): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const bal = await getEthBalance(chainId, addr);
    if (bal >= minBal) return bal;
    console.log(`    waiting... ${((Date.now()-start)/1000).toFixed(0)}s (${(Number(bal)/1e18).toFixed(6)} ETH)`);
    await new Promise(r => setTimeout(r, 8_000));
  }
  throw new Error(`Timeout waiting for ETH on chain ${chainId}`);
}

interface Result { backend: string; route: string; ok: boolean; time: string; tx: string; err?: string; }
const results: Result[] = [];

async function testBackend(
  name: string, backend: any, params: QuoteParams, wallet: ethers.Wallet,
  destChainId: number,
): Promise<bigint | null> {
  const t0 = Date.now();
  console.log(`\n━━━ ${name}: chain ${params.fromChainId} → ${params.toChainId} ━━━`);
  try {
    console.log(`  Getting quote...`);
    const quote = await backend.getQuote(params);
    if (!quote) throw new Error("No quote");
    console.log(`  Quote: ${quote.outputAmount} ETH (${quote.route})`);

    console.log(`  Building tx...`);
    const tx = await backend.buildTransaction(quote);

    if (tx.approvalTx) {
      const signer = wallet.connect(getProvider(params.fromChainId));
      const appr = await signer.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: 0n });
      await appr.wait();
      console.log(`  Approved`);
    }

    const preBal = await getEthBalance(destChainId, params.fromAddress!);
    const signer = wallet.connect(getProvider(params.fromChainId));

    console.log(`  Sending...`);
    const txRes = await signer.sendTransaction({
      to: tx.to, data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    });
    console.log(`  Tx: ${txRes.hash}`);
    const receipt = await txRes.wait();
    if (!receipt || receipt.status === 0) throw new Error("Reverted on-chain");
    console.log(`  Confirmed block ${receipt.blockNumber}`);

    console.log(`  Waiting for fill...`);
    const newBal = await waitForEth(destChainId, params.fromAddress!, preBal + 1n, 300_000);
    const received = newBal - preBal;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✅ Got ${(Number(received)/1e18).toFixed(6)} ETH (${elapsed}s)`);
    results.push({ backend: name, route: `${params.fromChainId}→${destChainId}`, ok: true, time: `${elapsed}s`, tx: txRes.hash });
    return newBal;
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = (err as Error).message?.slice(0, 120) ?? "unknown";
    console.log(`  ❌ ${msg} (${elapsed}s)`);
    results.push({ backend: name, route: `${params.fromChainId}→${destChainId}`, ok: false, time: `${elapsed}s`, tx: "N/A", err: msg });
    return null;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Testing LI.FI, Across, Relay (ETH chain)   ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!);
  const addr = wallet.address;
  console.log(`Wallet: ${addr}`);

  const lifi = new LiFiBackend();
  const across = new AcrossBackend();
  const relay = new RelayBackend();

  const baseEth = await getEthBalance(8453, addr);
  console.log(`Base ETH: ${(Number(baseEth)/1e18).toFixed(6)}`);

  // Use 0.001 ETH per test
  const testAmount = "1000000000000000"; // 0.001 ETH

  // ── 1. LI.FI: ETH Base → ETH Optimism ────────────────────────────
  let opBal = await testBackend("LI.FI", lifi, {
    fromChainId: 8453, toChainId: 10,
    fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
    amountRaw: testAmount, fromAddress: addr, preference: "cheapest"
  }, wallet, 10);

  // If LI.FI failed, try Across as fallback to get ETH on OP
  if (!opBal) {
    console.log(`\n  LI.FI failed. Using Across Base→OP as fallback...`);
    opBal = await testBackend("Across (fallback Base→OP)", across, {
      fromChainId: 8453, toChainId: 10,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: testAmount, fromAddress: addr, preference: "cheapest"
    }, wallet, 10);
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 2. Across: ETH Optimism → ETH Arbitrum ───────────────────────
  if (opBal && opBal > 500000000000000n) {
    const amount = (opBal / 2n).toString();
    const arbBal = await testBackend("Across", across, {
      fromChainId: 10, toChainId: 42161,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: amount, fromAddress: addr, preference: "cheapest"
    }, wallet, 42161);

    await new Promise(r => setTimeout(r, 5000));

    // ── 3. Relay: ETH Arbitrum → ETH Base ─────────────────────────
    if (arbBal && arbBal > 100000000000000n) {
      const amount2 = (arbBal / 2n).toString();
      await testBackend("Relay", relay, {
        fromChainId: 42161, toChainId: 8453,
        fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
        amountRaw: amount2, fromAddress: addr, preference: "cheapest"
      }, wallet, 8453);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\n\n═══ RESULTS ═══\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.backend.padEnd(24)} ${r.route.padEnd(12)} ${r.time.padEnd(10)} ${r.tx.slice(0, 14)}${r.err ? ` — ${r.err.slice(0, 60)}` : ''}`);
  }
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
