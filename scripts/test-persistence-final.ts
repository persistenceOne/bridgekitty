// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Final Persistence Interop test: BTCB (BSC) → cbBTC (Base)
 */
import { ethers } from "ethers";
import { PersistenceBackend } from "../src/backends/persistence.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const BASE_RPC = "https://mainnet.base.org";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const bscWallet = new ethers.Wallet(PRIVATE_KEY, bscProvider);

  const bscBnb = await bscProvider.getBalance(WALLET);
  const btcbContract = new ethers.Contract(BTCB_BSC, ERC20_ABI, bscProvider);
  const btcbBal = await btcbContract.balanceOf(WALLET);
  console.log(`BSC BNB: ${ethers.formatEther(bscBnb)}`);
  console.log(`BSC BTCB: ${ethers.formatUnits(btcbBal, 18)}`);

  if (btcbBal < ethers.parseUnits("0.00005", 18)) {
    console.log("❌ Not enough BTCB"); process.exit(1);
  }

  const persistence = new PersistenceBackend();
  console.log(`\n=== Persistence Interop: BTCB (BSC) → cbBTC (Base) ===`);
  
  // Use 0.000055 BTCB (just above minimum)
  const amount = ethers.parseUnits("0.000055", 18).toString();
  console.log(`Amount: 0.000055 BTCB (${amount} raw)`);

  const quote = await persistence.getQuote({
    fromChainId: 56, toChainId: 8453,
    fromTokenAddress: BTCB_BSC, toTokenAddress: CBBTC_BASE,
    amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });

  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Output: ${quote.outputAmount} cbBTC | Gas: $${quote.estimatedGasCostUsd} | Route: ${quote.route}`);

  const txRequest = await persistence.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to} | value: ${txRequest.value}`);

  if (txRequest.approvalTx) {
    let nonce = await bscProvider.getTransactionCount(WALLET, "pending");
    console.log(`\nApproving (nonce ${nonce})...`);
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

    if (receipt!.status === 1) {
      console.log("\n⏳ Waiting 30s for bridge status...");
      await new Promise(r => setTimeout(r, 30000));
      const status = await persistence.getStatus(txRequest.trackingId!, { txHash: btx.hash, fromChain: "56" });
      console.log(`Bridge: ${status.state} — ${status.humanReadable}`);
      
      // Check cbBTC balance on Base
      const cbBTCContract = new ethers.Contract(CBBTC_BASE, ERC20_ABI, baseProvider);
      const cbBTCBal = await cbBTCContract.balanceOf(WALLET);
      console.log(`cbBTC on Base: ${ethers.formatUnits(cbBTCBal, 8)}`);
    }
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
