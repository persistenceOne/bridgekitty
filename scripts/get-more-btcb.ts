// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Bridge more USDC → BTCB on BSC via LI.FI to reach Persistence minimum
 * Need 0.00005 BTC total, have 0.0000232. Need ~0.00003 more (~$3)
 */
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const arbProvider = new ethers.JsonRpcProvider(ARB_RPC);
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const arbWallet = new ethers.Wallet(PRIVATE_KEY, arbProvider);

  const usdcContract = new ethers.Contract(USDC_ARB, ERC20_ABI, arbProvider);
  const usdcBal = await usdcContract.balanceOf(WALLET);
  console.log(`Arb USDC: ${ethers.formatUnits(usdcBal, 6)}`);

  const lifi = new LiFiBackend();
  // Bridge 2.0 USDC → BTCB
  const amount = "2000000"; // 2.0 USDC
  console.log(`\n=== LI.FI: 2.0 USDC (Arb) → BTCB (BSC) ===`);

  const quote = await lifi.getQuote({
    fromChainId: 42161, toChainId: 56,
    fromTokenAddress: USDC_ARB, toTokenAddress: BTCB_BSC,
    amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });
  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Output: ${quote.minOutputAmount} BTCB | Route: ${quote.route}`);

  const txRequest = await lifi.buildTransaction(quote);

  if (txRequest.approvalTx) {
    let nonce = await arbProvider.getTransactionCount(WALLET, "pending");
    console.log(`Approving (nonce ${nonce})...`);
    const atx = await arbWallet.sendTransaction({
      to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100000n
    });
    await atx.wait();
    console.log("✅ Approved");
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await arbWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://arbiscan.io/tx/${btx.hash}`);

    if (receipt!.status === 1) {
      console.log("⏳ Waiting 60s for BTCB...");
      await new Promise(r => setTimeout(r, 60000));
      const btcbContract = new ethers.Contract(BTCB_BSC, ERC20_ABI, bscProvider);
      const btcbBal = await btcbContract.balanceOf(WALLET);
      console.log(`BTCB on BSC: ${ethers.formatUnits(btcbBal, 18)} (need >= 0.00005)`);
    }
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
