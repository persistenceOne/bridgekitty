/**
 * Debug deBridge: print create-tx response and try sending with all params
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(resolve(__dirname2, "../.env.acp"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const OP_RPC = "https://mainnet.optimism.io";
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function main() {
  const provider = new ethers.JsonRpcProvider(OP_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Call deBridge API directly
  const url = `https://deswap.debridge.finance/v1.0/dln/order/create-tx?srcChainId=10&srcChainTokenIn=${USDC_OP}&srcChainTokenInAmount=100000&dstChainId=8453&dstChainTokenOut=${USDC_BASE}&dstChainTokenOutAmount=auto&srcChainOrderAuthorityAddress=${WALLET}&dstChainTokenOutRecipient=${WALLET}&senderAddress=${WALLET}&srcChainRefundAddress=${WALLET}&dstChainOrderAuthorityAddress=${WALLET}&prependOperatingExpenses=true`;
  
  console.log("Calling create-tx...");
  const res = await fetch(url);
  const data = await res.json();
  
  console.log("Response keys:", Object.keys(data));
  if (data.tx) {
    console.log("tx.to:", data.tx.to);
    console.log("tx.data length:", data.tx.data?.length);
    console.log("tx.data first 20:", data.tx.data?.slice(0, 20));
    console.log("tx.value:", data.tx.value);
    console.log("tx.gasLimit:", data.tx.gasLimit);
  }
  if (data.estimation) {
    console.log("estimation:", JSON.stringify(data.estimation, null, 2).slice(0, 500));
  }
  if (data.error || data.errorMessage) {
    console.log("ERROR:", data.error, data.errorMessage);
    return;
  }

  // Try sending with full tx data
  console.log("\nSending bridge tx...");
  const tx = await wallet.sendTransaction({
    to: data.tx.to,
    data: data.tx.data,
    value: BigInt(data.tx.value),
    gasLimit: data.tx.gasLimit ? BigInt(data.tx.gasLimit) : undefined,
  });
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Status:", receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌");
  console.log("Gas used:", receipt!.gasUsed.toString());
  
  if (receipt!.status === 1) {
    console.log(`Explorer: https://optimistic.etherscan.io/tx/${tx.hash}`);
    console.log("Order ID:", data.orderId);
  }
}

main().catch(e => { console.error("❌", e.message ?? e); process.exit(1); });
