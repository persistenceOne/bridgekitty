// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Full Persistence Interop test:
 * 1. Bridge ETH (Arb) → BNB (BSC) for gas via LI.FI/GasZip
 * 2. Get Persistence quote for BTCB (BSC) → cbBTC (Base)
 * 3. Execute the bridge
 */
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";
import { PersistenceBackend } from "../src/backends/persistence.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const NATIVE = "0x0000000000000000000000000000000000000000";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const arbProvider = new ethers.JsonRpcProvider(ARB_RPC);
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const arbWallet = new ethers.Wallet(PRIVATE_KEY, arbProvider);
  const bscWallet = new ethers.Wallet(PRIVATE_KEY, bscProvider);

  let bscBnb = await bscProvider.getBalance(WALLET);
  console.log(`BSC BNB: ${ethers.formatEther(bscBnb)}`);

  // Step 1: Get BNB for gas if needed
  if (bscBnb < ethers.parseEther("0.0005")) {
    console.log("\n=== Step 1: Bridge ETH (Arb) → BNB (BSC) for gas ===");
    const lifi = new LiFiBackend();
    const gasQuote = await lifi.getQuote({
      fromChainId: 42161, toChainId: 56,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: "500000000000000", // 0.0005 ETH
      fromAddress: WALLET, toAddress: WALLET, preference: "cheapest",
    });
    if (!gasQuote) { console.log("❌ No gas bridge quote"); process.exit(1); }
    console.log(`Will get ~${gasQuote.minOutputAmount} BNB | Route: ${gasQuote.route}`);

    const gasTx = await lifi.buildTransaction(gasQuote);
    let nonce = await arbProvider.getTransactionCount(WALLET, "pending");
    console.log(`Sending gas bridge (nonce ${nonce})...`);
    const tx = await arbWallet.sendTransaction({
      to: gasTx.to, data: gasTx.data, value: BigInt(gasTx.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${tx.hash}`);
    const r = await tx.wait();
    console.log(`Status: ${r!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);

    if (r!.status === 1) {
      console.log("⏳ Waiting 30s for BNB to arrive...");
      await new Promise(r => setTimeout(r, 30000));
      bscBnb = await bscProvider.getBalance(WALLET);
      console.log(`BSC BNB now: ${ethers.formatEther(bscBnb)}`);
      if (bscBnb < ethers.parseEther("0.0001")) {
        console.log("⏳ Not yet, waiting another 30s...");
        await new Promise(r => setTimeout(r, 30000));
        bscBnb = await bscProvider.getBalance(WALLET);
        console.log(`BSC BNB now: ${ethers.formatEther(bscBnb)}`);
      }
    }
  }

  // Check BTCB balance
  const btcbContract = new ethers.Contract(BTCB_BSC, ERC20_ABI, bscProvider);
  const btcbBal = await btcbContract.balanceOf(WALLET);
  console.log(`\nBSC BTCB: ${ethers.formatUnits(btcbBal, 18)}`);

  if (btcbBal === 0n) {
    console.log("❌ No BTCB on BSC"); process.exit(1);
  }

  // Step 2: Persistence Interop quote
  console.log("\n=== Step 2: Persistence Interop BTCB (BSC) → cbBTC (Base) ===");
  const persistence = new PersistenceBackend();
  
  // Use all BTCB we have — but check against min/max (0.00005 - 0.001 BTC, 8 decimals)
  // BTCB is 18 decimals, need to convert
  const btcbAmount = btcbBal.toString();
  console.log(`BTCB raw (18 dec): ${btcbAmount}`);
  console.log(`BTCB human: ${ethers.formatUnits(btcbBal, 18)}`);

  const quote = await persistence.getQuote({
    fromChainId: 56, toChainId: 8453,
    fromTokenAddress: BTCB_BSC, toTokenAddress: CBBTC_BASE,
    amountRaw: btcbAmount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });

  if (!quote) {
    console.log("❌ No Persistence quote");
    // Try getting quotes to see what's available
    const quotes = await persistence.getQuotes?.({
      fromChainId: 56, toChainId: 8453,
      fromTokenAddress: BTCB_BSC, toTokenAddress: CBBTC_BASE,
      amountRaw: btcbAmount, fromAddress: WALLET, toAddress: WALLET,
      preference: "cheapest",
    });
    console.log("getQuotes result:", quotes?.length ?? "no getQuotes method");
    process.exit(1);
  }

  console.log(`Quote: ${quote.outputAmount} cbBTC | Gas: $${quote.estimatedGasCostUsd} | Route: ${quote.route}`);

  // Step 3: Build and execute
  console.log("\n=== Step 3: Execute Persistence bridge ===");
  const txRequest = await persistence.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to} | value: ${txRequest.value}`);

  if (txRequest.approvalTx) {
    let nonce = await bscProvider.getTransactionCount(WALLET, "pending");
    console.log(`Approving (nonce ${nonce})...`);
    const atx = await bscWallet.sendTransaction({
      to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100000n,
    });
    await atx.wait();
    console.log("✅ Approved");
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await bscWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://bscscan.com/tx/${btx.hash}`);
  } else {
    let nonce = await bscProvider.getTransactionCount(WALLET, "pending");
    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await bscWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n,
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://bscscan.com/tx/${btx.hash}`);
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
