// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Test deBridge bridge: ETH on Arbitrum → USDC on Base
 * Validates the approval target fix (Bug 1)
 */
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET_ADDRESS = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";

// We need to call BridgeKitty via MCP tools. Instead, let's test the deBridge backend directly.
import { DeBridgeBackend } from "../src/backends/debridge.js";

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("Wallet:", wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log("ETH balance:", ethers.formatEther(balance));

  const backend = new DeBridgeBackend();

  // Quote: 0.001 ETH (Arbitrum) → USDC (Base)
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const amountRaw = ethers.parseEther("0.0001").toString();

  console.log("\n=== Getting deBridge quote ===");
  console.log(`0.0001 ETH (Arbitrum) → USDC (Base)`);
  
  const quote = await backend.getQuote({
    fromChainId: 42161,
    toChainId: 8453,
    fromTokenAddress: NATIVE,
    toTokenAddress: USDC_BASE,
    amountRaw,
    fromAddress: wallet.address,
    toAddress: wallet.address,
    preference: "cheapest",
  });

  if (!quote) {
    console.log("❌ No quote returned");
    process.exit(1);
  }

  console.log(`Quote: ${quote.minOutputAmount} min: ${quote.minOutputAmount} gas: ${quote.estimatedGasCostUsd}`);

  console.log("\n=== Building transaction ===");
  const txRequest = await backend.buildTransaction(quote);
  
  console.log(`TX to: ${txRequest.to}`);
  console.log(`value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);
  
  if (txRequest.approvalTx) {
    console.log(`\n⚠️  Approval needed (this is for native ETH — shouldn't happen!)`);
    console.log(`Approval to: ${txRequest.approvalTx.to}`);
  } else {
    console.log(`\n✅ No approval needed (native ETH — correct!)`);
  }

  // For native ETH we don't need approval. Let's check nonce and send.
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  console.log(`\nCurrent nonce: ${nonce}`);
  
  // Get gas price
  const feeData = await provider.getFeeData();
  console.log(`Gas price: ${ethers.formatUnits(feeData.gasPrice ?? 0n, "gwei")} gwei`);

  console.log("\n=== Sending bridge transaction ===");
  const tx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: BigInt(txRequest.value),
    nonce,
    gasLimit: 500000n,
  });
  
  console.log(`TX: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`Status: ${receipt!.status === 1 ? "SUCCESS" : "FAILED"} | Gas: $${(Number(receipt!.gasUsed * (receipt!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
  console.log(`Explorer: https://arbiscan.io/tx/${tx.hash}`);
  
  // Check status after a delay
  if (receipt!.status === 1) {
    console.log("\n=== Checking bridge status (waiting 10s) ===");
    await new Promise(r => setTimeout(r, 10000));
    const status = await backend.getStatus(txRequest.trackingId!, { txHash: tx.hash, fromChain: "42161" });
    console.log(`Status: ${status.state} — ${status.humanReadable}`);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
