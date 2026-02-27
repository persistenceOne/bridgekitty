// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Test deBridge: USDC (Base) → USDC (Arbitrum) — full E2E with approval fix
 */
import { ethers } from "ethers";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const BASE_RPC = "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);

  const ethBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`ETH: ${ethers.formatEther(ethBal)}`);
  console.log(`USDC: ${ethers.formatUnits(usdcBal, 6)}`);

  if (Number(ethers.formatUnits(usdcBal, 6)) < 0.4) {
    console.log("❌ Not enough USDC on Base"); process.exit(1);
  }

  const backend = new DeBridgeBackend();
  const amount = ethers.parseUnits("0.4", 6).toString(); // 0.40 USDC
  console.log(`\n=== Getting deBridge quote: 0.4 USDC Base → USDC Arb ===`);

  const quote = await backend.getQuote({
    fromChainId: 8453,
    toChainId: 42161,
    fromTokenAddress: USDC_BASE,
    toTokenAddress: USDC_ARB,
    amountRaw: amount,
    fromAddress: wallet.address,
    toAddress: wallet.address,
    preference: "cheapest",
  });

  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Quote: ${quote.outputAmount} min: ${quote.minOutputAmount} gas: ${quote.estimatedGasCostUsd}`);

  console.log("\n=== Building transaction ===");
  const txRequest = await backend.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to}`);
  console.log(`value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);

  if (txRequest.approvalTx) {
    const spender = "0x" + txRequest.approvalTx.data.slice(34, 74);
    console.log(`\n🔑 Approval: spender=${spender}`);
    console.log(`Spender matches tx.to: ${spender.toLowerCase() === txRequest.to.toLowerCase() ? "✅" : "❌"}`);

    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    console.log(`Approving (nonce ${nonce})...`);
    const approveTx = await wallet.sendTransaction({
      to: txRequest.approvalTx.to, data: txRequest.approvalTx.data,
      value: 0n, nonce, gasLimit: 100000n,
    });
    const ar = await approveTx.wait();
    console.log(`✅ Approved | Gas: $${(Number(ar!.gasUsed * (ar!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const bridgeTx = await wallet.sendTransaction({
      to: txRequest.to, data: txRequest.data,
      value: BigInt(txRequest.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${bridgeTx.hash}`);
    const receipt = await bridgeTx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"} | Gas: $${(Number(receipt!.gasUsed * (receipt!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
    console.log(`Explorer: https://basescan.org/tx/${bridgeTx.hash}`);

    if (receipt!.status === 1) {
      console.log("\n⏳ Waiting 15s...");
      await new Promise(r => setTimeout(r, 15000));
      const status = await backend.getStatus(txRequest.trackingId!, { txHash: bridgeTx.hash, fromChain: "8453" });
      console.log(`Bridge status: ${status.state} — ${status.humanReadable}`);
    }
  } else {
    console.log("No approval needed");
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    console.log(`Bridging (nonce ${nonce})...`);
    const bridgeTx = await wallet.sendTransaction({
      to: txRequest.to, data: txRequest.data,
      value: BigInt(txRequest.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${bridgeTx.hash}`);
    const receipt = await bridgeTx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://basescan.org/tx/${bridgeTx.hash}`);
  }
}

main().catch(e => { console.error("❌ Error:", e.message); process.exit(1); });
