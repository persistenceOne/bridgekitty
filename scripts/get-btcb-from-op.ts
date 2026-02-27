// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Bridge USDC (Optimism) → BTCB (BSC) via LI.FI
 * We have 5.7 USDC on OP, need ~$3 more of BTCB
 * Problem: 0 ETH on OP for gas. Use Relay to bridge from Base first.
 */
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";
import { RelayBackend } from "../src/backends/relay.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BASE_RPC = "https://mainnet.base.org";
const OP_RPC = "https://mainnet.optimism.io";
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const opProvider = new ethers.JsonRpcProvider(OP_RPC);
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const baseWallet = new ethers.Wallet(PRIVATE_KEY, baseProvider);
  const opWallet = new ethers.Wallet(PRIVATE_KEY, opProvider);

  const baseEth = await baseProvider.getBalance(WALLET);
  const opEth = await opProvider.getBalance(WALLET);
  console.log(`Base ETH: ${ethers.formatEther(baseEth)}`);
  console.log(`OP ETH: ${ethers.formatEther(opEth)}`);

  // Step 1: Get ETH on OP (bridge from Base if needed)
  if (opEth < ethers.parseEther("0.0001")) {
    console.log("\n=== Bridge ETH Base → OP for gas ===");
    const relay = new RelayBackend();
    const gasQuote = await relay.getQuote({
      fromChainId: 8453, toChainId: 10,
      fromTokenAddress: NATIVE, toTokenAddress: NATIVE,
      amountRaw: ethers.parseEther("0.00015").toString(),
      fromAddress: WALLET, toAddress: WALLET, preference: "cheapest",
    });
    if (!gasQuote) { console.log("❌ No gas bridge quote"); process.exit(1); }
    console.log(`Will get ~${gasQuote.minOutputAmount} ETH on OP`);

    const gasTx = await relay.buildTransaction(gasQuote);
    let nonce = await baseProvider.getTransactionCount(WALLET, "pending");
    const tx = await baseWallet.sendTransaction({
      to: gasTx.to, data: gasTx.data, value: BigInt(gasTx.value), nonce, gasLimit: 300000n,
    });
    console.log(`TX: ${tx.hash}`);
    const r = await tx.wait();
    console.log(`${r!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);

    if (r!.status === 1) {
      console.log("⏳ Waiting 15s...");
      await new Promise(r => setTimeout(r, 15000));
      const newOpEth = await opProvider.getBalance(WALLET);
      console.log(`OP ETH: ${ethers.formatEther(newOpEth)}`);
    }
  }

  // Step 2: Bridge USDC (OP) → BTCB (BSC)
  const usdcContract = new ethers.Contract(USDC_OP, ERC20_ABI, opProvider);
  const usdcBal = await usdcContract.balanceOf(WALLET);
  console.log(`\nOP USDC: ${ethers.formatUnits(usdcBal, 6)}`);

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
  } else {
    let nonce = await opProvider.getTransactionCount(WALLET, "pending");
    const btx = await opWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
