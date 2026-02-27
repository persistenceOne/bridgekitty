// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Now that OP has gas, bridge USDC (OP) → BTCB (BSC)
 */
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const OP_RPC = "https://mainnet.optimism.io";
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const opProvider = new ethers.JsonRpcProvider(OP_RPC);
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const opWallet = new ethers.Wallet(PRIVATE_KEY, opProvider);

  const opEth = await opProvider.getBalance(WALLET);
  const usdcContract = new ethers.Contract(USDC_OP, ERC20_ABI, opProvider);
  const usdcBal = await usdcContract.balanceOf(WALLET);
  console.log(`OP ETH: ${ethers.formatEther(opEth)}`);
  console.log(`OP USDC: ${ethers.formatUnits(usdcBal, 6)}`);

  const lifi = new LiFiBackend();
  const amount = "3500000"; // 3.5 USDC
  console.log(`\n=== LI.FI: 3.5 USDC (OP) → BTCB (BSC) ===`);

  const quote = await lifi.getQuote({
    fromChainId: 10, toChainId: 56,
    fromTokenAddress: USDC_OP, toTokenAddress: BTCB_BSC,
    amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });
  if (!quote) { console.log("❌ No quote"); process.exit(1); }
  console.log(`Output: ${quote.minOutputAmount} BTCB | Route: ${quote.route}`);

  const txRequest = await lifi.buildTransaction(quote);
  if (txRequest.approvalTx) {
    let nonce = await opProvider.getTransactionCount(WALLET, "pending");
    console.log(`Approving (nonce ${nonce})...`);
    const atx = await opWallet.sendTransaction({
      to: txRequest.approvalTx.to, data: txRequest.approvalTx.data, value: 0n, nonce, gasLimit: 100000n
    });
    await atx.wait();
    console.log("✅ Approved");
    nonce++;

    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await opWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://optimistic.etherscan.io/tx/${btx.hash}`);

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
