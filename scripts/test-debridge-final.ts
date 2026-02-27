// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Test deBridge E2E: small USDC (Base) → USDC (Arb)
 * Base has 0.001279 ETH (enough for operating expense) + 0.447 USDC
 */
import { ethers } from "ethers";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const BASE_RPC = "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ethBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`Base: ${ethers.formatEther(ethBal)} ETH, ${ethers.formatUnits(usdcBal, 6)} USDC`);

  const backend = new DeBridgeBackend();
  // Try 0.1 USDC — operating expense ~0.23 USDC so total ~0.33
  const amount = "100000"; // 0.1 USDC
  console.log(`\n=== deBridge: 0.1 USDC Base → USDC Arb ===`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: USDC_BASE, toTokenAddress: USDC_ARB,
    amountRaw: amount, fromAddress: wallet.address, toAddress: wallet.address,
    preference: "cheapest",
  });
  if (!quote) { console.log("❌ No quote (amount may be below minimum)"); process.exit(1); }
  console.log(`Output: ${quote.minOutputAmount} USDC | Gas: $${quote.estimatedGasCostUsd}`);

  const txRequest = await backend.buildTransaction(quote);
  const ethValue = BigInt(txRequest.value);
  console.log(`TX to: ${txRequest.to} | ETH value: ${ethers.formatEther(ethValue)}`);
  console.log(`ETH available: ${ethers.formatEther(ethBal)} | ETH needed: ~${ethers.formatEther(ethValue + 100000n * 6000000n)}`);

  if (ethBal < ethValue + 50000n) {
    console.log("❌ Not enough ETH"); process.exit(1);
  }

  if (txRequest.approvalTx) {
    const spender = "0x" + txRequest.approvalTx.data.slice(34, 74);
    const approvalAmountHex = "0x" + txRequest.approvalTx.data.slice(74);
    const approvalAmount = BigInt(approvalAmountHex);
    console.log(`\n🔑 Spender: ${spender} (= tx.to: ${spender.toLowerCase() === txRequest.to.toLowerCase() ? "✅" : "❌"})`);
    console.log(`Approval amount: ${ethers.formatUnits(approvalAmount, 6)} USDC (input was 0.1, includes op expenses: ${approvalAmount > 100000n ? "✅" : "❌"})`);

    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    console.log(`\nApproving (nonce ${nonce})...`);
    const atx = await wallet.sendTransaction({ to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100000n });
    const ar = await atx.wait();
    console.log(`✅ Approved | Gas used: ${ar!.gasUsed}`);
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await wallet.sendTransaction({ to: txRequest.to, data: txRequest.data, value: ethValue, nonce, gasLimit: 500000n });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"} | Gas used: ${receipt!.gasUsed}`);
    console.log(`Explorer: https://basescan.org/tx/${btx.hash}`);

    if (receipt!.status === 1) {
      console.log("\n⏳ Checking status in 15s...");
      await new Promise(r => setTimeout(r, 15000));
      const status = await backend.getStatus(txRequest.trackingId!, { txHash: btx.hash, fromChain: "8453" });
      console.log(`Bridge: ${status.state} — ${status.humanReadable}`);
    }
  } else {
    console.log("No approval needed — sending bridge tx directly");
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    const btx = await wallet.sendTransaction({ to: txRequest.to, data: txRequest.data, value: ethValue, nonce, gasLimit: 500000n });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://basescan.org/tx/${btx.hash}`);
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
