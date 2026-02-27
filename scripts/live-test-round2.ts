// Round 2: Test Across (fixed) and deBridge from Arbitrum
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";
import { DeBridgeBackend } from "../src/backends/debridge.js";
import { AcrossBackend } from "../src/backends/across.js";
import { RelayBackend } from "../src/backends/relay.js";
import { RoutingEngine } from "../src/routing/engine.js";
import type { QuoteParams } from "../src/backends/types.js";
import fs from "fs";

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getProvider(chainId: number) { return new ethers.JsonRpcProvider(RPCS[chainId]); }
function getWallet(chainId: number) { return new ethers.Wallet(PRIVATE_KEY, getProvider(chainId)); }

async function getBalances(address: string) {
  const balances: Record<string, { eth: string; usdc: string }> = {};
  for (const [cid, _] of Object.entries(RPCS)) {
    const chainId = Number(cid);
    const provider = new ethers.JsonRpcProvider(RPCS[chainId]);
    const ethBal = await provider.getBalance(address);
    const usdc = new ethers.Contract(USDC[chainId], ERC20_ABI, provider);
    const usdcBal = await usdc.balanceOf(address);
    balances[CHAIN_NAMES[chainId]] = { eth: ethers.formatEther(ethBal), usdc: ethers.formatUnits(usdcBal, 6) };
  }
  return balances;
}

async function pollStatus(engine: RoutingEngine, backendName: string, trackingId: string, txHash: string, fromChain: number, toChain: number, maxWaitMs = 180_000): Promise<string> {
  const backend = engine.getBackend(backendName)!;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await backend.getStatus(trackingId, { txHash, fromChain: String(fromChain), toChain: String(toChain) });
      console.log(`  Status: ${status.state} — ${status.humanReadable}`);
      if (["completed", "failed", "refunded"].includes(status.state)) return status.state;
    } catch (e) { console.log(`  Status check error: ${(e as Error).message}`); }
    await sleep(15_000);
  }
  return "timeout";
}

interface TestPlan { label: string; backend: string; fromChain: number; toChain: number; amountUsdc: string; }

const TESTS: TestPlan[] = [
  { label: "Across (fixed)", backend: "across", fromChain: 42161, toChain: 10, amountUsdc: "0.55" },
  { label: "deBridge", backend: "debridge", fromChain: 42161, toChain: 8453, amountUsdc: "0.25" },
];

async function main() {
  const lifi = new LiFiBackend(undefined, "bridgekitty", undefined);
  const debridge = new DeBridgeBackend(undefined, undefined);
  const relay = new RelayBackend(undefined, undefined);
  const across = new AcrossBackend(undefined);
  const engine = new RoutingEngine([lifi, debridge, relay, across]);

  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const address = wallet.address;
  console.log(`\n🐱 BridgeKitty Live Test — Round 2`);
  console.log(`Wallet: ${address}\nTime: ${new Date().toISOString()}\n`);

  console.log("=== Starting Balances ===");
  const startBalances = await getBalances(address);
  for (const [chain, bal] of Object.entries(startBalances)) console.log(`  ${chain}: ${bal.usdc} USDC, ${bal.eth} ETH`);

  const results: any[] = [];

  for (const test of TESTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🧪 ${test.label}: ${CHAIN_NAMES[test.fromChain]} → ${CHAIN_NAMES[test.toChain]} (${test.amountUsdc} USDC)`);
    console.log("=".repeat(60));

    const startTime = Date.now();
    const result: any = { label: test.label, backend: test.backend, route: `${CHAIN_NAMES[test.fromChain]} → ${CHAIN_NAMES[test.toChain]}`, amount: test.amountUsdc, txHash: "", status: "not_started", timeSeconds: 0 };

    try {
      const srcProvider = getProvider(test.fromChain);
      const srcWallet = getWallet(test.fromChain);
      const usdcContract = new ethers.Contract(USDC[test.fromChain], ERC20_ABI, srcProvider);
      const usdcBal = await usdcContract.balanceOf(address);
      const ethBal = await srcProvider.getBalance(address);
      const amountRaw = ethers.parseUnits(test.amountUsdc, 6).toString();

      console.log(`  Balance: ${ethers.formatUnits(usdcBal, 6)} USDC, ${ethers.formatEther(ethBal)} ETH`);

      if (BigInt(usdcBal) < BigInt(amountRaw)) throw new Error(`Insufficient USDC: have ${ethers.formatUnits(usdcBal, 6)}, need ${test.amountUsdc}`);
      if (BigInt(ethBal) < ethers.parseEther("0.00005")) throw new Error(`Insufficient ETH for gas: ${ethers.formatEther(ethBal)}`);

      console.log(`  Getting quotes...`);
      const params: QuoteParams = {
        fromChainId: test.fromChain, toChainId: test.toChain,
        fromTokenAddress: USDC[test.fromChain], toTokenAddress: USDC[test.toChain],
        amountRaw, fromAddress: address, toAddress: address, preference: "cheapest",
      };

      const quotes = await engine.getQuotes(params);
      console.log(`  Got ${quotes.length} quotes:`);
      for (const q of quotes) console.log(`    ${q.backendName}: ${q.minOutputAmount} USDC (gas: $${q.estimatedGasCostUsd ?? "?"}, ${q.estimatedTimeSeconds}s)`);

      const targetQuote = quotes.find(q => q.backendName === test.backend);
      if (!targetQuote) throw new Error(`No quote from ${test.backend}. Available: ${quotes.map(q => q.backendName).join(", ") || "none"}`);

      result.outputExpected = targetQuote.minOutputAmount;
      console.log(`  Selected: ${targetQuote.provider} → ${targetQuote.minOutputAmount} USDC`);

      console.log(`  Building transaction...`);
      const backend = engine.getBackend(test.backend)!;
      const txRequest = await backend.buildTransaction(targetQuote);
      const txValue = BigInt(txRequest.value);
      console.log(`  TX to: ${txRequest.to}, value: ${ethers.formatEther(txValue)} ETH`);

      // Check if we have enough ETH for value + gas
      const estimatedGasCost = ethers.parseEther("0.0002"); // conservative
      if (txValue + estimatedGasCost > ethBal) {
        throw new Error(`Insufficient ETH: need ~${ethers.formatEther(txValue + estimatedGasCost)} ETH (value: ${ethers.formatEther(txValue)}, gas: ~0.0002), have ${ethers.formatEther(ethBal)}`);
      }

      let nonce = await srcProvider.getTransactionCount(address, "pending");

      if (txRequest.approvalTx) {
        console.log(`  Sending approval (nonce ${nonce})...`);
        const approveTx = await srcWallet.sendTransaction({ to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100_000n });
        const approveReceipt = await approveTx.wait();
        console.log(`  ✅ Approved (gas: ${approveReceipt!.gasUsed})`);
        nonce++;
      }

      console.log(`  Sending bridge tx (nonce ${nonce})...`);
      const bridgeTx = await srcWallet.sendTransaction({
        to: txRequest.to, data: txRequest.data, value: txValue, nonce,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : 500_000n,
      });
      result.txHash = bridgeTx.hash;
      console.log(`  TX: ${bridgeTx.hash}`);

      const receipt = await bridgeTx.wait();
      if (receipt!.status !== 1) throw new Error(`Transaction reverted on-chain`);
      console.log(`  ✅ TX confirmed (gas: ${receipt!.gasUsed})`);

      console.log(`  ⏳ Polling bridge status...`);
      const finalStatus = await pollStatus(engine, test.backend, txRequest.trackingId, bridgeTx.hash, test.fromChain, test.toChain);
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

  console.log(`\n=== Final Balances ===`);
  const endBalances = await getBalances(address);
  for (const [chain, bal] of Object.entries(endBalances)) console.log(`  ${chain}: ${bal.usdc} USDC, ${bal.eth} ETH`);

  // Output summary
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    const icon = r.status === "completed" ? "✅" : r.status === "timeout" ? "⏳" : "❌";
    console.log(`${icon} ${r.label}: ${r.status} ${r.txHash ? `(${r.txHash.slice(0,10)}…)` : ""} ${r.error || ""}`);
  }

  // Write JSON for easy consumption
  const output = { startBalances, endBalances, results, timestamp: new Date().toISOString() };
  fs.writeFileSync("/Users/persistence/projects/bridgekitty/scripts/round2-results.json", JSON.stringify(output, null, 2));
  console.log("\n📄 JSON results written to scripts/round2-results.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
