// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Bridge 0.001 ETH (Base) → USDC (Polygon) via Relay
 */
import { ethers } from "ethers";
import { RelayBackend } from "../src/backends/relay.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BASE_RPC = "https://mainnet.base.org";
const POLY_RPC = "https://polygon-rpc.com";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC_POLY = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const polyProvider = new ethers.JsonRpcProvider(POLY_RPC);
  const baseWallet = new ethers.Wallet(PRIVATE_KEY, baseProvider);

  const baseEth = await baseProvider.getBalance(WALLET);
  console.log(`Base ETH: ${ethers.formatEther(baseEth)}`);

  const relay = new RelayBackend();
  // Use most of our ETH, leaving ~0.00002 for gas
  const available = baseEth - ethers.parseEther("0.00002");
  if (available <= 0n) { console.log("❌ Not enough ETH"); process.exit(1); }
  const amount = available.toString();
  console.log(`\n=== ${ethers.formatEther(available)} ETH (Base) → USDC (Polygon) via Relay ===`);

  const quote = await relay.getQuote({
    fromChainId: 8453, toChainId: 137,
    fromTokenAddress: NATIVE, toTokenAddress: USDC_POLY,
    amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });
  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Output: ${quote.minOutputAmount} USDC | Gas: $${quote.estimatedGasCostUsd} | ETA: ${quote.estimatedTimeSeconds}s`);

  const txRequest = await relay.buildTransaction(quote);
  let nonce = await baseProvider.getTransactionCount(WALLET, "pending");
  console.log(`\nBridging (nonce ${nonce})...`);
  const btx = await baseWallet.sendTransaction({
    to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 300000n,
  });
  console.log(`TX: ${btx.hash}`);
  const receipt = await btx.wait();
  console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"} | Gas: $${(Number(receipt!.gasUsed * (receipt!.gasPrice ?? 0n)) / 1e18 * 1850).toFixed(4)}`);
  console.log(`Explorer: https://basescan.org/tx/${btx.hash}`);

  if (receipt!.status === 1) {
    console.log("\n⏳ Waiting 15s...");
    await new Promise(r => setTimeout(r, 15000));
    const usdcContract = new ethers.Contract(USDC_POLY, ERC20_ABI, polyProvider);
    const usdcBal = await usdcContract.balanceOf(WALLET);
    console.log(`USDC on Polygon: ${ethers.formatUnits(usdcBal, 6)}`);
    
    const status = await relay.getStatus(txRequest.trackingId!, { txHash: btx.hash, fromChain: "8453" });
    console.log(`Bridge: ${status.state} — ${status.humanReadable}`);
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
