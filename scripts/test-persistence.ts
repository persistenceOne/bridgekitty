// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  WARNING: This script executes REAL transactions on MAINNET with    │
// │    REAL funds. Use extreme caution. Review all parameters before        │
// │    running. Loss of funds is possible if misconfigured.                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Step 1: Bridge USDC (Arb) → BTCB (BSC) via LI.FI cross-chain swap
 * Step 2: Bridge BTCB (BSC) → BTC/BTCB (Base) via Persistence Interop
 */
import { ethers } from "ethers";
import { LiFiBackend } from "../src/backends/lifi.js";
import { PersistenceBackend } from "../src/backends/persistence.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const BSC_RPC = "https://bsc-dataseed1.binance.org";

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";

async function main() {
  // Check balances
  const arbProvider = new ethers.JsonRpcProvider(ARB_RPC);
  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const arbWallet = new ethers.Wallet(PRIVATE_KEY, arbProvider);
  
  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const usdcContract = new ethers.Contract(USDC_ARB, erc20Abi, arbProvider);
  const usdcBal = await usdcContract.balanceOf(WALLET);
  const arbEth = await arbProvider.getBalance(WALLET);
  const bscBnb = await bscProvider.getBalance(WALLET);
  console.log(`Arb: ${ethers.formatEther(arbEth)} ETH, ${ethers.formatUnits(usdcBal, 6)} USDC`);
  console.log(`BSC: ${ethers.formatEther(bscBnb)} BNB`);

  // Step 1: Get LI.FI quote for USDC (Arb) → BTCB (BSC)
  const lifi = new LiFiBackend();
  const amount = "1500000"; // 1.5 USDC
  console.log(`\n=== Step 1: LI.FI quote for 1.5 USDC (Arb) → BTCB (BSC) ===`);
  
  const quote = await lifi.getQuote({
    fromChainId: 42161, toChainId: 56,
    fromTokenAddress: USDC_ARB, toTokenAddress: BTCB_BSC,
    amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });

  if (!quote) {
    console.log("❌ No LI.FI quote for USDC→BTCB cross-chain swap");
    
    // Fallback: try bridging USDC to BSC first, then we can swap on-chain
    console.log("\nTrying USDC (Arb) → USDC (BSC) instead...");
    const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
    const q2 = await lifi.getQuote({
      fromChainId: 42161, toChainId: 56,
      fromTokenAddress: USDC_ARB, toTokenAddress: USDC_BSC,
      amountRaw: amount, fromAddress: WALLET, toAddress: WALLET,
      preference: "cheapest",
    });
    if (!q2) {
      console.log("❌ No quote for USDC→USDC BSC either");
      process.exit(1);
    }
    console.log(`Quote: ${q2.minOutputAmount} USDC on BSC | Gas: $${q2.estimatedGasCostUsd}`);
    console.log("Would need to swap USDC→BTCB on BSC DEX after bridging (not supported by BridgeKitty)");
    process.exit(0);
  }

  console.log(`Quote: ${quote.minOutputAmount} BTCB | Gas: $${quote.estimatedGasCostUsd} | Route: ${quote.route}`);
  
  const txRequest = await lifi.buildTransaction(quote);
  console.log(`TX to: ${txRequest.to} | value: ${ethers.formatEther(BigInt(txRequest.value))} ETH`);
  
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
      console.log("\n⏳ Waiting 60s for cross-chain + swap to complete...");
      await new Promise(r => setTimeout(r, 60000));
      const btcbContract = new ethers.Contract(BTCB_BSC, erc20Abi, bscProvider);
      const btcbBal = await btcbContract.balanceOf(WALLET);
      console.log(`BTCB balance on BSC: ${ethers.formatUnits(btcbBal, 18)}`);
    }
  } else {
    let nonce = await arbProvider.getTransactionCount(WALLET, "pending");
    console.log(`Bridging (nonce ${nonce})...`);
    const btx = await arbWallet.sendTransaction({
      to: txRequest.to, data: txRequest.data, value: BigInt(txRequest.value), nonce, gasLimit: 500000n
    });
    console.log(`TX: ${btx.hash}`);
    const receipt = await btx.wait();
    console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"}`);
    console.log(`Explorer: https://arbiscan.io/tx/${btx.hash}`);
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
