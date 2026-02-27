/**
 * deBridge: 0.10 USDC Optimism → Base (fresh approval + send in one go)
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
// Bridge from Optimism → Base (OP has ~0.001 ETH + 0.20 USDC)
const SRC_RPC = "https://mainnet.optimism.io";
const SRC_CHAIN_ID = 10;
const DST_CHAIN_ID = 8453;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const SRC_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const DST_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DLN_SOURCE = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";

async function main() {
  const provider = new ethers.JsonRpcProvider(SRC_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const ethBal = await provider.getBalance(wallet.address);
  console.log(`ETH: ${ethers.formatEther(ethBal)}`);

  // 1. Approve max to DlnSource
  const erc20 = new ethers.Contract(SRC_USDC, [
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], wallet);

  const allowance = await erc20.allowance(wallet.address, DLN_SOURCE);
  if (allowance < ethers.MaxUint256 / 2n) {
    console.log("Approving max USDC to DlnSource...");
    const atx = await erc20.approve(DLN_SOURCE, ethers.MaxUint256);
    await atx.wait();
    console.log("✅ Approved");
  }

  // 2. Get fresh create-tx (0.20 USDC Base → Optimism)
  const url = `https://deswap.debridge.finance/v1.0/dln/order/create-tx?srcChainId=${SRC_CHAIN_ID}&srcChainTokenIn=${SRC_USDC}&srcChainTokenInAmount=200000&dstChainId=${DST_CHAIN_ID}&dstChainTokenOut=${DST_USDC}&dstChainTokenOutAmount=auto&srcChainOrderAuthorityAddress=${WALLET}&dstChainTokenOutRecipient=${WALLET}&senderAddress=${WALLET}&srcChainRefundAddress=${WALLET}&dstChainOrderAuthorityAddress=${WALLET}&prependOperatingExpenses=true`;

  console.log("Getting create-tx...");
  const res = await fetch(url);
  const data = await res.json();
  if (!data.tx?.data) { console.log("❌ No tx data:", JSON.stringify(data).slice(0, 300)); return; }

  const pullAmount = data.estimation?.srcChainTokenIn?.amount;
  console.log(`Will pull: ${pullAmount} raw USDC (${Number(pullAmount) / 1e6} USDC)`);
  console.log(`Protocol fee: ${ethers.formatEther(BigInt(data.tx.value))} ETH`);

  // 3. Send bridge tx immediately
  console.log("Sending bridge tx...");
  const tx = await wallet.sendTransaction({
    to: data.tx.to,
    data: data.tx.data,
    value: BigInt(data.tx.value),
  });
  console.log(`TX: ${tx.hash}`);
  console.log(`Explorer: https://basescan.org/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Status: ${receipt!.status === 1 ? "SUCCESS ✅" : "FAILED ❌"} | Gas: ${receipt!.gasUsed}`);

  if (receipt!.status !== 1) { process.exit(1); }

  // 4. Poll status
  const orderId = data.orderId;
  console.log(`\n⏳ Order: ${orderId}`);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const sRes = await fetch(`https://deswap.debridge.finance/v1.0/dln/order/${orderId}/status`);
      const sData = await sRes.json();
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[${elapsed}s] ${sData.status}`);
      if (["Fulfilled", "SentUnlock", "ClaimedUnlock"].includes(sData.status)) {
        console.log("✅ Bridge completed!");
        break;
      }
      if (["OrderCancelled", "SentOrderCancel", "ClaimedOrderCancel"].includes(sData.status)) {
        console.log("❌ Bridge failed/cancelled");
        break;
      }
    } catch (e: any) {
      console.log(`Status error: ${e.message}`);
    }
  }

  // 5. Check destination (Optimism) USDC
  const dstProvider = new ethers.JsonRpcProvider("https://mainnet.optimism.io");
  const dstUsdc = new ethers.Contract(DST_USDC, ["function balanceOf(address) view returns (uint256)"], dstProvider);
  console.log(`\nOptimism USDC: ${ethers.formatUnits(await dstUsdc.balanceOf(wallet.address), 6)}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
