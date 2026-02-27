/**
 * Bridge 0.20 USDC from Optimism → Base via deBridge
 * Uses BridgeKitty's DeBridgeBackend
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(resolve(__dirname2, "../.env.acp"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const OP_RPC = "https://mainnet.optimism.io";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT = "100000"; // 0.10 USDC
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(OP_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ethBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(USDC_OP, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`Optimism: ${ethers.formatEther(ethBal)} ETH, ${ethers.formatUnits(usdcBal, 6)} USDC`);

  const backend = new DeBridgeBackend();
  console.log(`\n=== deBridge: 0.10 USDC Optimism → USDC Base ===`);

  const quote = await backend.getQuote({
    fromChainId: 10,
    toChainId: 8453,
    fromTokenAddress: USDC_OP,
    toTokenAddress: USDC_BASE,
    amountRaw: AMOUNT,
    fromAddress: wallet.address,
    toAddress: wallet.address,
    preference: "cheapest",
  });

  if (!quote) {
    console.log("❌ No quote returned");
    process.exit(1);
  }

  console.log(`Output: ${quote.minOutputAmount} | Gas: $${quote.estimatedGasCostUsd}`);

  const txRequest = await backend.buildTransaction(quote);
  const ethValue = BigInt(txRequest.value);
  console.log(`TX to: ${txRequest.to} | ETH value: ${ethers.formatEther(ethValue)}`);

  if (ethBal < ethValue + 100000n) {
    console.log("❌ Not enough ETH for protocol fee + gas");
    process.exit(1);
  }

  // Handle approval if needed
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  if (txRequest.approvalTx) {
    console.log(`Approving (nonce ${nonce})...`);
    const atx = await wallet.sendTransaction({
      to: txRequest.approvalTx.to,
      data: txRequest.approvalTx.data,
      value: 0n,
      nonce,
      gasLimit: 100000n,
    });
    const ar = await atx.wait();
    console.log(`✅ Approved | tx: ${atx.hash} | gas: ${ar!.gasUsed}`);
    nonce++;
  }

  // Send bridge tx
  console.log(`Bridging (nonce ${nonce})...`);
  const btx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: ethValue,
    nonce,
    gasLimit: 500000n,
  });
  console.log(`TX: ${btx.hash}`);
  console.log(`Explorer: https://optimistic.etherscan.io/tx/${btx.hash}`);

  const receipt = await btx.wait();
  console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"} | Gas: ${receipt!.gasUsed}`);

  if (receipt!.status !== 1) {
    console.log("❌ Transaction failed on-chain");
    process.exit(1);
  }

  // Poll status for up to 3 minutes
  console.log("\n⏳ Polling deBridge status (up to 3 min)...");
  const trackingId = txRequest.trackingId!;
  const startTime = Date.now();
  const TIMEOUT = 180_000;

  while (Date.now() - startTime < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const status = await backend.getStatus(trackingId, {
        txHash: btx.hash,
        fromChain: "10",
      });
      console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] ${status.state} — ${status.humanReadable}`);
      if (status.state === "completed" || status.state === "failed" || status.state === "refunded") {
        break;
      }
    } catch (e: any) {
      console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] Status check error: ${e.message}`);
    }
  }

  // Check Base USDC balance
  const baseProvider = new ethers.JsonRpcProvider("https://mainnet.base.org");
  const baseUsdc = new ethers.Contract(USDC_BASE, ERC20_ABI, baseProvider);
  const baseUsdcBal = await baseUsdc.balanceOf(wallet.address);
  console.log(`\nBase USDC balance: ${ethers.formatUnits(baseUsdcBal, 6)}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
