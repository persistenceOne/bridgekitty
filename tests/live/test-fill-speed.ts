#!/usr/bin/env tsx
/**
 * Quick test: one Persistence round trip (Base→BSC→Base) to measure fill detection speed.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import { createFillWatcher, checkBalanceChange, checkTransferEvents, getCurrentBlockNumber } from "../../src/utils/fill-detector.js";
import { getProvider } from "../../src/utils/gas-estimator.js";

// Load .env
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("Missing PRIVATE_KEY in .env"); process.exit(1); }

const CBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function getBalance(chainId: number, token: string, wallet: string): Promise<bigint> {
  const p = await getProvider(chainId);
  const c = new ethers.Contract(token, ERC20_ABI, p);
  return c.balanceOf(wallet);
}

async function doLeg(label: string, persistence: PersistenceBackend, signer: ethers.Wallet, fromChain: number, toChain: number, fromToken: string, destToken: string, amountRaw: string) {
  console.log(`\n── ${label} ──`);
  
  // Get quote
  const quote = await persistence.getQuote({ fromChainId: fromChain, toChainId: toChain, fromTokenAddress: fromToken, toTokenAddress: destToken, amountRaw });
  if (!quote) { console.log("No quote!"); return false; }
  console.log(`Quote: ${quote.outputAmount} (${quote.route})`);

  // Pre-balance
  const preBal = await getBalance(toChain, destToken, signer.address);
  console.log(`Pre-balance on dest chain: ${preBal}`);

  // Create watcher BEFORE signing
  const watcher = createFillWatcher(toChain, destToken, signer.address, () => {
    console.log(`🚀 FILL PUSHED via WS!`);
  });

  let startBlock: number;
  try { startBlock = Math.max(0, await getCurrentBlockNumber(toChain) - 2); } catch { startBlock = 0; }

  // Execute
  const t0 = Date.now();
  const result = await persistence.signAndExecute(quote, signer);
  const txTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Source tx confirmed in ${txTime}s: ${result.txHash}`);

  // Poll for fill
  const fillStart = Date.now();
  const POLL_MS = 2000;
  const MAX_POLLS = 90; // 3 min max
  let filled = false;

  for (let w = 0; w < MAX_POLLS; w++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const elapsed = ((Date.now() - fillStart) / 1000).toFixed(1);

    // Check WS
    if (watcher.isDetected()) {
      console.log(`✅ Fill detected via WS push in ${elapsed}s (${watcher.connectedCount()} WS conns)`);
      filled = true; break;
    }

    // Check getLogs
    try {
      const ev = await checkTransferEvents(toChain, destToken, signer.address, startBlock, w);
      if (ev.found) { console.log(`✅ Fill detected via getLogs in ${elapsed}s`); filled = true; break; }
    } catch {}

    // Check balance
    try {
      const bal = await checkBalanceChange(toChain, destToken, signer.address, preBal, w);
      if (bal.changed) { console.log(`✅ Fill detected via balance in ${elapsed}s`); filled = true; break; }
    } catch {}

    if (w % 5 === 4) console.log(`  polling... ${elapsed}s (WS conns: ${watcher.connectedCount()})`);
  }

  watcher.cleanup();

  if (!filled) {
    console.log(`❌ Fill not detected within 3 min`);
    return false;
  }
  return true;
}

async function main() {
  const persistence = new PersistenceBackend();
  const signer = new ethers.Wallet(PRIVATE_KEY!);
  console.log(`Wallet: ${signer.address}`);

  // Leg 1: Base → BSC (cbBTC → BTCB)
  const baseBal = await getBalance(8453, CBTC_BASE, signer.address);
  console.log(`cbBTC balance on Base: ${baseBal} (${Number(baseBal) / 1e8} BTC)`);
  
  if (baseBal < 5000n) {
    // Try BSC first
    const bscBal = await getBalance(56, BTCB_BSC, signer.address);
    console.log(`BTCB balance on BSC: ${bscBal} (${Number(bscBal / 10n**10n) / 1e8} BTC)`);
    if (bscBal < 5000n * 10n**10n) { console.log("Insufficient balance on both chains"); return; }
    
    const ok1 = await doLeg("Leg 1: BSC → Base", persistence, signer, 56, 8453, BTCB_BSC, CBTC_BASE, bscBal.toString());
    if (!ok1) return;
    
    await new Promise(r => setTimeout(r, 5000));
    const newBal = await getBalance(8453, CBTC_BASE, signer.address);
    const ok2 = await doLeg("Leg 2: Base → BSC", persistence, signer, 8453, 56, CBTC_BASE, BTCB_BSC, newBal.toString());
    if (!ok2) return;
  } else {
    const ok1 = await doLeg("Leg 1: Base → BSC", persistence, signer, 8453, 56, CBTC_BASE, BTCB_BSC, baseBal.toString());
    if (!ok1) return;
    
    await new Promise(r => setTimeout(r, 5000));
    const bscBal = await getBalance(56, BTCB_BSC, signer.address);
    const ok2 = await doLeg("Leg 2: BSC → Base", persistence, signer, 56, 8453, BTCB_BSC, CBTC_BASE, bscBal.toString());
    if (!ok2) return;
  }
  
  console.log("\n🎉 Round trip complete!");
}

main().catch(e => { console.error(e); process.exit(1); });
