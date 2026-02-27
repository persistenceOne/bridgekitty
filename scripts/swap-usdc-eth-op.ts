/**
 * Swap 1.5 USDC → ETH on Optimism using LiFi API
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
const RPC_URL = "https://mainnet.optimism.io";
const WALLET_ADDR = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const ETH_ADDR = "0x0000000000000000000000000000000000000000";
const AMOUNT = "1500000"; // 1.5 USDC (6 decimals)

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("Wallet:", wallet.address);
  console.log("ETH balance before:", ethers.formatEther(await provider.getBalance(wallet.address)));

  // 1. Get LiFi quote
  const quoteUrl = `https://li.quest/v1/quote?fromChain=10&toChain=10&fromToken=${USDC_OP}&toToken=${ETH_ADDR}&fromAmount=${AMOUNT}&fromAddress=${WALLET_ADDR}`;
  console.log("Fetching LiFi quote...");
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`LiFi quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  console.log("Quote received. Estimated output:", quote.estimate?.toAmount, "wei ETH");

  // 2. Check if approval is needed
  const approvalAddr = quote.estimate?.approvalAddress;
  if (approvalAddr) {
    const erc20 = new ethers.Contract(USDC_OP, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], wallet);

    const allowance = await erc20.allowance(wallet.address, approvalAddr);
    if (allowance < BigInt(AMOUNT)) {
      console.log("Approving USDC spend...");
      const approveTx = await erc20.approve(approvalAddr, ethers.MaxUint256);
      console.log("Approval tx:", approveTx.hash);
      await approveTx.wait();
      console.log("Approved!");
    } else {
      console.log("Already approved.");
    }
  }

  // 3. Send swap tx
  const txRequest = quote.transactionRequest;
  if (!txRequest) {
    throw new Error("No transactionRequest in quote");
  }

  console.log("Sending swap tx...");
  const tx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value ?? "0x0",
    gasLimit: txRequest.gasLimit,
    gasPrice: txRequest.gasPrice,
  });
  console.log("Swap tx:", tx.hash);

  // 4. Wait for confirmation
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt?.blockNumber);

  // 5. Log new ETH balance
  const newBalance = await provider.getBalance(wallet.address);
  console.log("ETH balance after:", ethers.formatEther(newBalance));
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
