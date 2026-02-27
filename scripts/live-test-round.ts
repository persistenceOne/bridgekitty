// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  MAINNET LIVE TEST — Uses real funds. Small amounts only.           │
// └─────────────────────────────────────────────────────────────────────────┘

import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";
import { DeBridgeBackend } from "../src/backends/debridge.js";
import { AcrossBackend } from "../src/backends/across.js";
import { RelayBackend } from "../src/backends/relay.js";
import { RoutingEngine } from "../src/routing/engine.js";
import type { BridgeQuote, QuoteParams } from "../src/backends/types.js";
import type { CachedQuote } from "../src/routing/engine.js";
import fs from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
if (!PRIVATE_KEY) throw new Error("TEST_BUYER_PRIVATE_KEY not set");

const RPCS: Record<number, string> = {
  10: "https://mainnet.optimism.io",
  42161: "https://arb1.arbitrum.io/rpc",
  8453: "https://mainnet.base.org",
};

const USDC: Record<number, string> = {
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const CHAIN_NAMES: Record<number, string> = { 10: "Optimism", 42161: "Arbitrum", 8453: "Base" };
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];

interface TestPlan {
  label: string;
  targetBackend: string;
  fromChain: number;
  toChain: number;
  amountUsdc: string; // human readable e.g. "0.30"
}

const TESTS: TestPlan[] = [
  { label: "LiFi", targetBackend: "lifi", fromChain: 10, toChain: 42161, amountUsdc: "0.25" },
  { label: "deBridge", targetBackend: "debridge", fromChain: 10, toChain: 8453, amountUsdc: "0.25" },
  { label: "Across", targetBackend: "across", fromChain: 42161, toChain: 10, amountUsdc: "0.25" },
  { label: "Relay", targetBackend: "relay", fromChain: 10, toChain: 8453, amountUsdc: "0.25" },
];

interface TestResult {
  label: string;
  provider: string;
  route: string;
  amount: string;
  outputExpected: string;
  txHash: string;
  status: string;
  timeSeconds: number;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProvider(chainId: number) {
  return new ethers.JsonRpcProvider(RPCS[chainId]);
}

function getWallet(chainId: number) {
  return new ethers.Wallet(PRIVATE_KEY, getProvider(chainId));
}

async function getBalances(address: string) {
  const balances: Record<string, { eth: string; usdc: string }> = {};
  for (const [chainIdStr, rpc] of Object.entries(RPCS)) {
    const chainId = Number(chainIdStr);
    const provider = new ethers.JsonRpcProvider(rpc);
    const ethBal = await provider.getBalance(address);
    const usdc = new ethers.Contract(USDC[chainId], ERC20_ABI, provider);
    const usdcBal = await usdc.balanceOf(address);
    balances[CHAIN_NAMES[chainId]] = {
      eth: ethers.formatEther(ethBal),
      usdc: ethers.formatUnits(usdcBal, 6),
    };
  }
  return balances;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pollStatus(engine: RoutingEngine, backendName: string, trackingId: string, txHash: string, fromChain: number, toChain: number, maxWaitMs = 180_000): Promise<string> {
  const backend = engine.getBackend(backendName)!;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await backend.getStatus(trackingId, {
        txHash,
        fromChain: String(fromChain),
        toChain: String(toChain),
      });
      console.log(`  Status: ${status.state} — ${status.humanReadable}`);
      if (status.state === "completed" || status.state === "failed" || status.state === "refunded") {
        return status.state;
      }
    } catch (e) {
      console.log(`  Status check error: ${(e as Error).message}`);
    }
    await sleep(15_000);
  }
  return "timeout";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // No fees for testing — avoids config issues with LiFi portal / deBridge limits
  const lifi = new LiFiBackend(undefined, "bridgekitty", undefined);
  const debridge = new DeBridgeBackend(undefined, undefined);
  const relay = new RelayBackend(undefined, undefined);
  const across = new AcrossBackend(undefined);
  const engine = new RoutingEngine([lifi, debridge, relay, across]);

  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const address = wallet.address;
  console.log(`\n🐱 BridgeKitty Live Test Round`);
  console.log(`Wallet: ${address}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Check starting balances
  console.log("=== Starting Balances ===");
  const startBalances = await getBalances(address);
  for (const [chain, bal] of Object.entries(startBalances)) {
    console.log(`  ${chain}: ${bal.usdc} USDC, ${bal.eth} ETH`);
  }

  const results: TestResult[] = [];

  for (const test of TESTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🧪 Test: ${test.label} — ${CHAIN_NAMES[test.fromChain]} → ${CHAIN_NAMES[test.toChain]} (${test.amountUsdc} USDC)`);
    console.log("=".repeat(60));

    const startTime = Date.now();
    const result: TestResult = {
      label: test.label,
      provider: test.targetBackend,
      route: `${CHAIN_NAMES[test.fromChain]} → ${CHAIN_NAMES[test.toChain]}`,
      amount: `${test.amountUsdc} USDC`,
      outputExpected: "",
      txHash: "",
      status: "not_started",
      timeSeconds: 0,
    };

    try {
      // Check balance
      const srcProvider = getProvider(test.fromChain);
      const srcWallet = getWallet(test.fromChain);
      const usdcContract = new ethers.Contract(USDC[test.fromChain], ERC20_ABI, srcProvider);
      const usdcBal = await usdcContract.balanceOf(address);
      const ethBal = await srcProvider.getBalance(address);
      const amountRaw = ethers.parseUnits(test.amountUsdc, 6).toString();

      console.log(`  Balance: ${ethers.formatUnits(usdcBal, 6)} USDC, ${ethers.formatEther(ethBal)} ETH`);

      if (BigInt(usdcBal) < BigInt(amountRaw)) {
        throw new Error(`Insufficient USDC: have ${ethers.formatUnits(usdcBal, 6)}, need ${test.amountUsdc}`);
      }
      if (BigInt(ethBal) < ethers.parseEther("0.00005")) {
        throw new Error(`Insufficient ETH for gas: have ${ethers.formatEther(ethBal)}`);
      }

      // Get quotes from all backends
      console.log(`  Getting quotes...`);
      const params: QuoteParams = {
        fromChainId: test.fromChain,
        toChainId: test.toChain,
        fromTokenAddress: USDC[test.fromChain],
        toTokenAddress: USDC[test.toChain],
        amountRaw,
        fromAddress: address,
        toAddress: address,
        preference: "cheapest",
      };

      const quotes = await engine.getQuotes(params);
      console.log(`  Got ${quotes.length} quotes:`);
      for (const q of quotes) {
        console.log(`    ${q.backendName}: ${q.minOutputAmount} USDC (gas: $${q.estimatedGasCostUsd ?? "?"}, ${q.estimatedTimeSeconds}s)`);
      }

      // Find the target backend's quote
      const targetQuote = quotes.find(q => q.backendName === test.targetBackend);
      if (!targetQuote) {
        const available = quotes.map(q => q.backendName).join(", ");
        throw new Error(`No quote from ${test.targetBackend}. Available: ${available || "none"}`);
      }

      result.outputExpected = targetQuote.minOutputAmount + " USDC";
      result.provider = targetQuote.provider;
      console.log(`  Selected: ${targetQuote.provider} → ${targetQuote.minOutputAmount} USDC`);

      // Build transaction
      console.log(`  Building transaction...`);
      const backend = engine.getBackend(test.targetBackend)!;
      const txRequest = await backend.buildTransaction(targetQuote);
      console.log(`  TX to: ${txRequest.to}, value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);

      // Send approval if needed
      let nonce = await srcProvider.getTransactionCount(address, "pending");

      if (txRequest.approvalTx) {
        console.log(`  Sending approval (nonce ${nonce})...`);
        const approveTx = await srcWallet.sendTransaction({
          to: txRequest.approvalTx.to,
          data: txRequest.approvalTx.data,
          value: 0n,
          nonce,
          gasLimit: 100_000n,
        });
        const approveReceipt = await approveTx.wait();
        console.log(`  ✅ Approved (gas: ${approveReceipt!.gasUsed})`);
        nonce++;
      }

      // Send bridge transaction
      console.log(`  Sending bridge tx (nonce ${nonce})...`);
      const bridgeTx = await srcWallet.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: BigInt(txRequest.value),
        nonce,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : 500_000n,
      });
      result.txHash = bridgeTx.hash;
      console.log(`  TX: ${bridgeTx.hash}`);

      const receipt = await bridgeTx.wait();
      if (receipt!.status !== 1) {
        throw new Error(`Transaction reverted on-chain`);
      }
      console.log(`  ✅ TX confirmed (gas: ${receipt!.gasUsed})`);

      // Poll for bridge completion
      console.log(`  ⏳ Polling bridge status...`);
      const finalStatus = await pollStatus(engine, test.targetBackend, txRequest.trackingId, bridgeTx.hash, test.fromChain, test.toChain);
      result.status = finalStatus;
      result.timeSeconds = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Final: ${finalStatus} (${result.timeSeconds}s)`);

    } catch (e) {
      result.status = "error";
      result.error = (e as Error).message;
      result.timeSeconds = Math.round((Date.now() - startTime) / 1000);
      console.log(`  ❌ Error: ${result.error}`);
    }

    results.push(result);
  }

  // Final balances
  console.log(`\n=== Final Balances ===`);
  const endBalances = await getBalances(address);
  for (const [chain, bal] of Object.entries(endBalances)) {
    console.log(`  ${chain}: ${bal.usdc} USDC, ${bal.eth} ETH`);
  }

  // Write results
  const passed = results.filter(r => r.status === "completed").length;
  const total = results.length;

  let md = `# BridgeKitty Live Test Results\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Wallet:** \`${address}\`\n`;
  md += `**Result:** ${passed}/${total} passed\n\n`;

  md += `## Starting Balances\n\n`;
  md += `| Chain | USDC | ETH |\n|-------|------|-----|\n`;
  for (const [chain, bal] of Object.entries(startBalances)) {
    md += `| ${chain} | ${bal.usdc} | ${bal.eth} |\n`;
  }

  md += `\n## Test Results\n\n`;
  md += `| # | Provider | Route | Amount | Expected Output | TX Hash | Status | Time |\n`;
  md += `|---|----------|-------|--------|-----------------|---------|--------|------|\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const txLink = r.txHash ? `\`${r.txHash.slice(0, 10)}…\`` : "—";
    md += `| ${i + 1} | ${r.provider} | ${r.route} | ${r.amount} | ${r.outputExpected || "—"} | ${txLink} | ${r.status} | ${r.timeSeconds}s |\n`;
  }

  if (results.some(r => r.error)) {
    md += `\n## Errors\n\n`;
    for (const r of results.filter(r => r.error)) {
      md += `- **${r.label}:** ${r.error}\n`;
    }
  }

  md += `\n## Final Balances\n\n`;
  md += `| Chain | USDC | ETH |\n|-------|------|-----|\n`;
  for (const [chain, bal] of Object.entries(endBalances)) {
    md += `| ${chain} | ${bal.usdc} | ${bal.eth} |\n`;
  }

  md += `\n## Overall: ${passed === total ? "✅ ALL PASSED" : `⚠️ ${passed}/${total} PASSED`}\n`;

  fs.writeFileSync("/Users/persistence/projects/bridgekitty/LIVE-TEST-RESULTS.md", md);
  console.log(`\n📄 Results written to LIVE-TEST-RESULTS.md`);
  console.log(`\n🏁 ${passed}/${total} tests passed`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
