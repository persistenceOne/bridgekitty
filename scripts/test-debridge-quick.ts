import { ethers } from "ethers";
import { DeBridgeBackend } from "../src/backends/debridge.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET_ADDR = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const OP_RPC = "https://mainnet.optimism.io";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(OP_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  const ethBal = await provider.getBalance(WALLET_ADDR);
  console.log(`ETH: ${ethers.formatEther(ethBal)}`);

  const backend = new DeBridgeBackend();
  
  // Get fresh quote
  console.log("\n1. Getting quote...");
  const quote = await backend.getQuote({
    fromChainId: 10, toChainId: 8453,
    fromTokenAddress: USDC_OP, toTokenAddress: USDC_BASE,
    amountRaw: "100000", // 0.10 USDC
    fromAddress: WALLET_ADDR, toAddress: WALLET_ADDR,
    preference: "cheapest",
  });
  
  if (!quote) { console.log("❌ No quote"); return; }
  console.log(`Quote: ${quote.minOutputAmount} USDC, gas ~$${quote.estimatedGasCostUsd}`);
  
  // Build tx immediately (fresh)
  console.log("\n2. Building tx...");
  const txReq = await backend.buildTransaction(quote);
  console.log(`to: ${txReq.to}`);
  console.log(`data: ${txReq.data?.slice(0, 40)}... (${txReq.data?.length} chars)`);
  console.log(`value: ${txReq.value}`);
  
  if (!txReq.data || txReq.data.length < 10) {
    console.log("❌ No calldata returned from buildTransaction!");
    console.log("Full txReq:", JSON.stringify(txReq, null, 2));
    return;
  }
  
  // Log approval details
  if (txReq.approvalTx) {
    // Decode approval amount from calldata (approve(address,uint256) = 0x095ea7b3 + 32bytes addr + 32bytes amount)
    const approvalData = txReq.approvalTx.data;
    if (approvalData && approvalData.length >= 138) {
      const amountHex = approvalData.slice(74);
      console.log(`Approval amount (raw): ${BigInt('0x' + amountHex)}`);
      console.log(`Approval amount (USDC): ${Number(BigInt('0x' + amountHex)) / 1e6}`);
    }
  }

  const ethValue = BigInt(txReq.value || "0");
  const totalNeeded = ethValue + 200000n; // value + gas buffer
  if (ethBal < totalNeeded) {
    console.log(`❌ Need ${ethers.formatEther(totalNeeded)} ETH, have ${ethers.formatEther(ethBal)}`);
    return;
  }

  // Approval if needed
  let nonce = await provider.getTransactionCount(WALLET_ADDR, "pending");
  if (txReq.approvalTx) {
    console.log(`\n3. Approving (nonce ${nonce})...`);
    const atx = await wallet.sendTransaction({
      to: txReq.approvalTx.to, data: txReq.approvalTx.data,
      value: 0n, nonce, gasLimit: 100000n,
    });
    const ar = await atx.wait();
    console.log(`✅ Approved: ${atx.hash} (gas: ${ar!.gasUsed})`);
    nonce++;
  }

  // Bridge tx
  console.log(`\n4. Bridging (nonce ${nonce})...`);
  const btx = await wallet.sendTransaction({
    to: txReq.to, data: txReq.data, value: ethValue,
    nonce, gasLimit: 500000n,
  });
  console.log(`TX: ${btx.hash}`);
  
  const receipt = await btx.wait();
  console.log(`Status: ${receipt!.status === 1 ? "✅ SUCCESS" : "❌ REVERTED"} | Gas: ${receipt!.gasUsed}`);
  
  if (receipt!.status !== 1) return;

  // Poll status
  console.log("\n5. Polling status...");
  const trackingId = txReq.trackingId;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const s = await backend.getStatus(trackingId!, { txHash: btx.hash, fromChain: "10" });
      console.log(`[${(i+1)*15}s] ${s.state} — ${s.humanReadable}`);
      if (["completed","failed","refunded"].includes(s.state)) break;
    } catch (e: any) { console.log(`[${(i+1)*15}s] err: ${e.message}`); }
  }

  // Final balance
  const baseProvider = new ethers.JsonRpcProvider("https://mainnet.base.org");
  const baseUsdc = new ethers.Contract(USDC_BASE, ERC20_ABI, baseProvider);
  console.log(`\nBase USDC: ${ethers.formatUnits(await baseUsdc.balanceOf(WALLET_ADDR), 6)}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
