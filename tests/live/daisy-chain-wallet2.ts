#!/usr/bin/env tsx
/**
 * BridgeKitty — Daisy-Chain Test with Wallet 0x130E
 * Starts from BSC (BTCB) → Base → Optimism → Base → Linea → Scroll → Base
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

// Load ~/.bridgekitty/.env
const envPath = path.resolve(process.env.HOME + "/.bridgekitty/.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const NATIVE = "0x0000000000000000000000000000000000000000";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";

const RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed1.binance.org",
  10: "https://mainnet.optimism.io",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const backends: Record<string, any> = {
  lifi: new LiFiBackend(),
  skip: new SkipBackend(),
  debridge: new DeBridgeBackend(),
  across: new AcrossBackend(),
  relay: new RelayBackend(),
  persistence: new PersistenceBackend(),
};

function getProvider(chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPCS[chainId]);
}

async function getBalance(chainId: number, address: string, token: string): Promise<bigint> {
  const p = getProvider(chainId);
  if (token === NATIVE) return p.getBalance(address);
  return new ethers.Contract(token, ERC20_ABI, p).balanceOf(address);
}

function fmt(raw: bigint, dec: number): string {
  const s = raw.toString().padStart(dec + 1, "0");
  return `${s.slice(0, s.length - dec) || "0"}.${s.slice(s.length - dec, s.length - dec + 6)}`;
}

async function waitForBalance(chainId: number, addr: string, token: string, minBal: bigint, timeout = 600_000): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const bal = await getBalance(chainId, addr, token);
    if (bal >= minBal) return bal;
    console.log(`  ... waiting for balance (${fmt(bal, token === NATIVE ? 18 : 6)})`);
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error(`Timeout waiting for balance on chain ${chainId}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  BridgeKitty — Daisy-Chain Test (Wallet 0x130E)         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("Missing PRIVATE_KEY"); process.exit(1); }

  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  console.log(`Wallet: ${address}\n`);

  // Check starting balances
  const btcbBal = await getBalance(56, address, BTCB_BSC);
  const baseEth = await getBalance(8453, address, NATIVE);
  const bscBnb = await getBalance(56, address, NATIVE);
  console.log(`Starting balances:`);
  console.log(`  BTCB on BSC: ${fmt(btcbBal, 18)}`);
  console.log(`  ETH on Base: ${fmt(baseEth, 18)}`);
  console.log(`  BNB on BSC: ${fmt(bscBnb, 18)}\n`);

  if (btcbBal < 5000n * (10n**10n)) {
    console.log("Need at least 0.00005 BTCB on BSC to start");
    process.exit(1);
  }

  // ── HOP 0: BTCB BSC → cbBTC Base (Persistence) ───────────────────
  console.log("━━━ Hop 0: Persistence: BTCB BSC → cbBTC Base ━━━");
  const hop0Start = Date.now();
  const persistence = backends.persistence as PersistenceBackend;
  
  const q0 = await persistence.getQuote({
    fromChainId: 56, toChainId: 8453,
    fromTokenAddress: BTCB_BSC, toTokenAddress: CBBTC_BASE,
    amountRaw: btcbBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q0) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q0.outputAmount} cbBTC`);

  const signerBsc = wallet.connect(getProvider(56));
  const r0 = await persistence.signAndExecute(q0, signerBsc);
  console.log(`  Source tx: ${r0.txHash}`);
  console.log("  Waiting for fill...");

  let cbBTCBal = await waitForBalance(8453, address, CBBTC_BASE, 1n, 180_000);
  console.log(`  ✅ Got ${fmt(cbBTCBal, 8)} cbBTC on Base (${((Date.now()-hop0Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 1: cbBTC Base → BTCB BSC (Persistence) ───────────────────
  console.log("━━━ Hop 1: Persistence: cbBTC Base → BTCB BSC ━━━");
  const hop1Start = Date.now();
  
  const q1 = await persistence.getQuote({
    fromChainId: 8453, toChainId: 56,
    fromTokenAddress: CBBTC_BASE, toTokenAddress: BTCB_BSC,
    amountRaw: cbBTCBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q1) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q1.outputAmount} BTCB`);

  const signerBase = wallet.connect(getProvider(8453));
  const r1 = await persistence.signAndExecute(q1, signerBase);
  console.log(`  Source tx: ${r1.txHash}`);
  console.log("  Waiting for fill...");

  let btcBBal = await waitForBalance(56, address, BTCB_BSC, 1n, 180_000);
  console.log(`  ✅ Got ${fmt(btcBBal, 18)} BTCB on BSC (${((Date.now()-hop1Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 2: BTCB BSC → USDC Optimism (LI.FI) ──────────────────────
  console.log("━━━ Hop 2: LI.FI: BTCB BSC → USDC Optimism ━━━");
  const hop2Start = Date.now();
  const lifi = backends.lifi;

  const q2 = await lifi.getQuote({
    fromChainId: 56, toChainId: 10,
    fromTokenAddress: BTCB_BSC, toTokenAddress: USDC_OP,
    amountRaw: btcBBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q2) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q2.outputAmount} USDC (${q2.route})`);

  const tx2 = await lifi.buildTransaction(q2);
  const signerBsc2 = wallet.connect(getProvider(56));
  
  if (tx2.approvalTx) {
    const appr = await signerBsc2.sendTransaction({ to: tx2.approvalTx.to, data: tx2.approvalTx.data, value: 0n });
    await appr.wait();
    console.log(`  Approved`);
  }

  const tx2Res = await signerBsc2.sendTransaction({ to: tx2.to, data: tx2.data, value: BigInt(tx2.value || 0) });
  console.log(`  Bridge tx: ${tx2Res.hash}`);
  await tx2Res.wait();

  let usdcOpBal = await waitForBalance(10, address, USDC_OP, 1n, 300_000);
  console.log(`  ✅ Got ${fmt(usdcOpBal, 6)} USDC on Optimism (${((Date.now()-hop2Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 3: USDC Optimism → USDC Base (Skip/CCTP) ─────────────────
  console.log("━━━ Hop 3: Skip: USDC Optimism → USDC Base ━━━");
  const hop3Start = Date.now();
  const skip = backends.skip;

  const q3 = await skip.getQuote({
    fromChainId: 10, toChainId: 8453,
    fromTokenAddress: USDC_OP, toTokenAddress: USDC_BASE,
    amountRaw: usdcOpBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q3) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q3.outputAmount} USDC (${q3.route})`);

  const tx3 = await skip.buildTransaction(q3);
  const signerOp = wallet.connect(getProvider(10));
  
  if (tx3.approvalTx) {
    const appr = await signerOp.sendTransaction({ to: tx3.approvalTx.to, data: tx3.approvalTx.data, value: 0n });
    await appr.wait();
    console.log(`  Approved`);
  }

  const tx3Res = await signerOp.sendTransaction({ to: tx3.to, data: tx3.data, value: BigInt(tx3.value || 0) });
  console.log(`  Bridge tx: ${tx3Res.hash}`);
  await tx3Res.wait();

  console.log("  Waiting for CCTP attestation (can take 13-20 min)...");
  const usdcBaseBefore = await getBalance(8453, address, USDC_BASE);
  let usdcBaseBal = await waitForBalance(8453, address, USDC_BASE, usdcBaseBefore + 1n, 1_200_000);
  console.log(`  ✅ Got ${fmt(usdcBaseBal, 6)} USDC on Base (${((Date.now()-hop3Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 4: USDC Base → ETH Linea (deBridge) ──────────────────────
  console.log("━━━ Hop 4: deBridge: USDC Base → ETH Linea ━━━");
  const hop4Start = Date.now();
  const debridge = backends.debridge;

  const q4 = await debridge.getQuote({
    fromChainId: 8453, toChainId: 59144,
    fromTokenAddress: USDC_BASE, toTokenAddress: NATIVE,
    amountRaw: usdcBaseBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q4) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q4.outputAmount} ETH (${q4.route})`);

  const tx4 = await debridge.buildTransaction(q4);
  const signerBase4 = wallet.connect(getProvider(8453));
  
  if (tx4.approvalTx) {
    const appr = await signerBase4.sendTransaction({ to: tx4.approvalTx.to, data: tx4.approvalTx.data, value: 0n });
    await appr.wait();
    console.log(`  Approved`);
  }

  const tx4Res = await signerBase4.sendTransaction({ to: tx4.to, data: tx4.data, value: BigInt(tx4.value || 0) });
  console.log(`  Bridge tx: ${tx4Res.hash}`);
  await tx4Res.wait();

  let ethLineaBal = await waitForBalance(59144, address, NATIVE, 1n, 300_000);
  console.log(`  ✅ Got ${fmt(ethLineaBal, 18)} ETH on Linea (${((Date.now()-hop4Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 5: ETH Linea → ETH Scroll (Across) ───────────────────────
  console.log("━━━ Hop 5: Across: ETH Linea → ETH Scroll ━━━");
  const hop5Start = Date.now();
  const across = backends.across;

  const q5 = await across.getQuote({
    fromChainId: 59144, toChainId: 534352,
    fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
    amountRaw: ethLineaBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q5) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q5.outputAmount} ETH (${q5.route})`);

  const tx5 = await across.buildTransaction(q5);
  const signerLinea = wallet.connect(getProvider(59144));

  const tx5Res = await signerLinea.sendTransaction({ to: tx5.to, data: tx5.data, value: BigInt(tx5.value || ethLineaBal.toString()) });
  console.log(`  Bridge tx: ${tx5Res.hash}`);
  await tx5Res.wait();

  let ethScrollBal = await waitForBalance(534352, address, NATIVE, 1n, 300_000);
  console.log(`  ✅ Got ${fmt(ethScrollBal, 18)} ETH on Scroll (${((Date.now()-hop5Start)/1000).toFixed(1)}s)\n`);

  await new Promise(r => setTimeout(r, 3000));

  // ── HOP 6: ETH Scroll → ETH Base (Relay) ─────────────────────────
  console.log("━━━ Hop 6: Relay: ETH Scroll → ETH Base ━━━");
  const hop6Start = Date.now();
  const relay = backends.relay;

  const q6 = await relay.getQuote({
    fromChainId: 534352, toChainId: 8453,
    fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
    amountRaw: ethScrollBal.toString(), fromAddress: address, preference: "cheapest"
  });
  if (!q6) { console.log("No quote!"); process.exit(1); }
  console.log(`  Quote: ${q6.outputAmount} ETH (${q6.route})`);

  const tx6 = await relay.buildTransaction(q6);
  const signerScroll = wallet.connect(getProvider(534352));

  const tx6Res = await signerScroll.sendTransaction({ to: tx6.to, data: tx6.data, value: BigInt(tx6.value || ethScrollBal.toString()) });
  console.log(`  Bridge tx: ${tx6Res.hash}`);
  await tx6Res.wait();

  let ethBaseFinal = await waitForBalance(8453, address, NATIVE, 1n, 300_000);
  console.log(`  ✅ Got ${fmt(ethBaseFinal, 18)} ETH on Base (${((Date.now()-hop6Start)/1000).toFixed(1)}s)\n`);

  // ── Summary ───────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║                    DAISY-CHAIN COMPLETE!                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log("Route: BTCB(BSC) → cbBTC(Base) → BTCB(BSC) → USDC(OP) → USDC(Base) → ETH(Linea) → ETH(Scroll) → ETH(Base)");
  console.log("Backends: Persistence → Persistence → LI.FI → Skip → deBridge → Across → Relay\n");
  console.log(`Final ETH on Base: ${fmt(ethBaseFinal, 18)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
