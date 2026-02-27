/**
 * Swap 0.25 USDC → ETH on Optimism to top up for deBridge fee
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
const provider = new ethers.JsonRpcProvider("https://mainnet.optimism.io");
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const WALLET_ADDR = wallet.address;
const AMOUNT = "250000"; // 0.25 USDC

async function main() {
  console.log("ETH before:", ethers.formatEther(await provider.getBalance(WALLET_ADDR)));
  
  const quoteUrl = `https://li.quest/v1/quote?fromChain=10&toChain=10&fromToken=${USDC_OP}&toToken=0x0000000000000000000000000000000000000000&fromAmount=${AMOUNT}&fromAddress=${WALLET_ADDR}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  console.log("Est output:", quote.estimate?.toAmount, "wei ETH");

  const approvalAddr = quote.estimate?.approvalAddress;
  if (approvalAddr) {
    const erc20 = new ethers.Contract(USDC_OP, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], wallet);
    const allowance = await erc20.allowance(WALLET_ADDR, approvalAddr);
    if (allowance < BigInt(AMOUNT)) {
      console.log("Approving...");
      const atx = await erc20.approve(approvalAddr, ethers.MaxUint256);
      await atx.wait();
      console.log("Approved");
    }
  }

  const txr = quote.transactionRequest;
  const tx = await wallet.sendTransaction({ to: txr.to, data: txr.data, value: txr.value ?? "0x0", gasLimit: txr.gasLimit, gasPrice: txr.gasPrice });
  console.log("TX:", tx.hash);
  await tx.wait();
  console.log("ETH after:", ethers.formatEther(await provider.getBalance(WALLET_ADDR)));
}
main().catch(e => { console.error(e.message); process.exit(1); });
