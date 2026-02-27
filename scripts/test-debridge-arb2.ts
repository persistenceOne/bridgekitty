// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Test deBridge: 1.0 USDC (Arb) → USDC (Base) with fixed approval amount
 */
import { ethers } from "ethers";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  const ethBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`ETH: ${ethers.formatEther(ethBal)} | USDC: ${ethers.formatUnits(usdcBal, 6)}`);

  const backend = new DeBridgeBackend();
  const amount = "1000000"; // 1.0 USDC
  console.log(`\n=== deBridge quote: 1.0 USDC Arb → USDC Base ===`);

  const quote = await backend.getQuote({
    fromChainId: 42161, toChainId: 8453,
    fromTokenAddress: USDC_ARB, toTokenAddress: USDC_BASE,
    amountRaw: amount, fromAddress: wallet.address, toAddress: wallet.address,
    preference: "cheapest",
  });
  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Output: ${quote.minOutputAmount} USDC | Gas: $${quote.estimatedGasCostUsd}`);

  const txRequest = await backend.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to} | value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);
  
  // Check if we can afford the ETH value
  const ethNeeded = BigInt(txRequest.value) + 500000n * 100000000n; // value + ~gas
  console.log(`ETH needed (approx): ${ethers.formatEther(ethNeeded)} | Have: ${ethers.formatEther(ethBal)}`);
  
  if (ethBal < ethNeeded) {
    console.log("❌ Not enough ETH for operating expenses. deBridge requires ETH even for ERC20 bridges.");
    console.log("Trying without prependOperatingExpenses...");
    process.exit(1);
  }

  if (txRequest.approvalTx) {
    const spender = "0x" + txRequest.approvalTx.data.slice(34, 74);
    console.log(`\n🔑 Approval spender: ${spender} (matches tx.to: ${spender.toLowerCase() === txRequest.to.toLowerCase() ? "✅" : "❌"})`);
    
    // Decode approval amount from data
    const approvalAmountHex = "0x" + txRequest.approvalTx.data.slice(74);
    const approvalAmount = BigInt(approvalAmountHex);
    console.log(`Approval amount: ${ethers.formatUnits(approvalAmount, 6)} USDC (user input was 1.0 USDC)`);
    console.log(`Includes operating expenses: ${approvalAmount > 1000000n ? "✅ YES" : "❌ NO"}`);

    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    console.log(`\nApproving (nonce ${nonce})...`);
    const approveTx = await wallet.sendTransaction({
      to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100000n,
    });
    await approveTx.wait();
    console.log(`✅ Approved`);
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const bridgeTx = await wallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${bridgeTx.hash}`);
    const receipt = await bridgeTx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://arbiscan.io/tx/${bridgeTx.hash}`);
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
