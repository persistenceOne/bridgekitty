import { ethers } from "ethers";
import { RelayBackend } from "../src/backends/relay.js";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BASE_RPC = "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const AMOUNT = "500000"; // 0.50 USDC

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("1. Getting Relay quote Base→OP 0.50 USDC...");
  const backend = new RelayBackend();
  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 10,
    fromTokenAddress: USDC_BASE, toTokenAddress: USDC_OP,
    amountRaw: AMOUNT, fromAddress: WALLET, toAddress: WALLET,
    preference: "fastest",
  });
  
  if (!quote) { console.log("❌ No quote from Relay, trying LiFi..."); return; }
  console.log(`Quote: receive ${quote.minOutputAmount} USDC on OP`);

  console.log("\n2. Building tx...");
  const txReq = await backend.buildTransaction(quote);
  console.log(`to: ${txReq.to}, data: ${txReq.data?.length} chars, value: ${txReq.value}`);

  let nonce = await provider.getTransactionCount(WALLET, "pending");

  if (txReq.approvalTx) {
    console.log(`\n3. Approving (nonce ${nonce})...`);
    const atx = await wallet.sendTransaction({
      to: txReq.approvalTx.to, data: txReq.approvalTx.data,
      value: 0n, nonce, gasLimit: 100000n,
    });
    await atx.wait();
    console.log(`✅ Approved: ${atx.hash}`);
    nonce++;
  }

  console.log(`\n4. Bridging (nonce ${nonce})...`);
  const ethValue = BigInt(txReq.value || "0");
  const btx = await wallet.sendTransaction({
    to: txReq.to, data: txReq.data, value: ethValue,
    nonce, gasLimit: 300000n,
  });
  console.log(`TX: ${btx.hash}`);
  const receipt = await btx.wait();
  console.log(`${receipt!.status === 1 ? "✅ SUCCESS" : "❌ REVERTED"} | Gas: ${receipt!.gasUsed}`);

  if (receipt!.status !== 1) return;

  console.log("\n5. Waiting 60s for bridge to complete...");
  await new Promise(r => setTimeout(r, 60000));

  // Check OP balance
  const opProvider = new ethers.JsonRpcProvider("https://mainnet.optimism.io");
  const opUsdc = new ethers.Contract(USDC_OP, ["function balanceOf(address) view returns (uint256)"], opProvider);
  console.log(`OP USDC: ${ethers.formatUnits(await opUsdc.balanceOf(WALLET), 6)}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
