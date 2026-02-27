// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Test deBridge: USDC (Arbitrum) → USDC (Base) — validates approval fix
 */
import { ethers } from "ethers";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);

  const ethBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`ETH: ${ethers.formatEther(ethBal)}`);
  console.log(`USDC: ${ethers.formatUnits(usdcBal, 6)}`);

  const backend = new DeBridgeBackend();
  // Bridge 1.5 USDC
  const amount = "1500000"; // 1.5 USDC (6 decimals)
  console.log("\n=== Getting deBridge quote: 1.5 USDC Arb → USDC Base ===");

  const quote = await backend.getQuote({
    fromChainId: 42161,
    toChainId: 8453,
    fromTokenAddress: USDC_ARB,
    toTokenAddress: USDC_BASE,
    amountRaw: amount,
    fromAddress: wallet.address,
    toAddress: wallet.address,
    preference: "cheapest",
  });

  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Quote: ${quote.minOutputAmount} min: ${quote.minOutputAmount} gas: ${quote.estimatedGasCostUsd}`);

  console.log("\n=== Building transaction ===");
  const txRequest = await backend.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to}`);
  console.log(`value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);

  if (txRequest.approvalTx) {
    console.log(`\n🔑 Approval needed!`);
    console.log(`Approve token: ${txRequest.approvalTx.to}`);
    // Decode the spender from approval data
    const spender = "0x" + txRequest.approvalTx.data.slice(34, 74);
    console.log(`Approve spender: ${spender}`);
    console.log(`DlnSource (tx.to): ${txRequest.to}`);
    console.log(`Spender matches tx.to: ${spender.toLowerCase() === txRequest.to.toLowerCase() ? "✅ YES" : "❌ NO"}`);

    // Check current allowance
    const currentAllowance = await usdc.allowance(wallet.address, spender);
    console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 6)}`);

    // Send approval
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    console.log(`\nApproving (nonce ${nonce})...`);
    const approveTx = await wallet.sendTransaction({
      to: txRequest.approvalTx.to,
      data: txRequest.approvalTx.data,
      value: 0n,
      nonce,
      gasLimit: 100000n,
    });
    const approveReceipt = await approveTx.wait();
    console.log(`✅ Approved | Gas: $${(Number(approveReceipt!.gasUsed * (approveReceipt!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
    nonce++;

    // Send bridge tx
    console.log(`\nBridging (nonce ${nonce})...`);
    const bridgeTx = await wallet.sendTransaction({
      to: txRequest.to,
      data: txRequest.data,
      value: BigInt(txRequest.value),
      nonce,
      gasLimit: 500000n,
    });
    console.log(`TX: ${bridgeTx.hash}`);
    const receipt = await bridgeTx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS" : "FAILED"} | Gas: $${(Number(receipt!.gasUsed * (receipt!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
    console.log(`Explorer: https://arbiscan.io/tx/${bridgeTx.hash}`);

    if (receipt!.status === 1) {
      console.log("\n⏳ Waiting 15s for bridge status...");
      await new Promise(r => setTimeout(r, 15000));
      const status = await backend.getStatus(txRequest.trackingId!, { txHash: bridgeTx.hash, fromChain: "42161" });
      console.log(`Status: ${status.state} — ${status.humanReadable}`);
    }
  } else {
    console.log("❌ No approval tx returned — bug not triggered (native token?)");
  }
}

main().catch(e => { console.error("❌ Error:", e.message); process.exit(1); });
