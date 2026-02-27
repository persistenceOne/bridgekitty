import { ethers } from "ethers";

const PRIVATE_KEY = process.env.TEST_BUYER_PRIVATE_KEY!;
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const BASE_RPC = "https://mainnet.base.org";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ETH_ADDR = "0x0000000000000000000000000000000000000000";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Swap 0.005 ETH → cbBTC via LiFi (same-chain swap on Base)
const SWAP_AMOUNT = ethers.parseEther("0.001"); // ~$2.70 worth

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  const ethBal = await provider.getBalance(WALLET);
  console.log(`Base ETH: ${ethers.formatEther(ethBal)}`);
  
  if (ethBal < SWAP_AMOUNT + ethers.parseEther("0.0005")) {
    console.log("❌ Not enough ETH"); return;
  }

  // Get LiFi quote for ETH → cbBTC on Base
  console.log("\n1. Getting LiFi quote ETH→cbBTC on Base...");
  const url = `https://li.quest/v1/quote?fromChain=8453&toChain=8453&fromToken=${ETH_ADDR}&toToken=${CBBTC}&fromAmount=${SWAP_AMOUNT.toString()}&fromAddress=${WALLET}`;
  const resp = await fetch(url);
  if (!resp.ok) { console.log("❌ Quote failed:", await resp.text()); return; }
  const data = await resp.json();
  
  const toAmount = data.estimate?.toAmount;
  const toAmountMin = data.estimate?.toAmountMin;
  console.log(`Swap: ${ethers.formatEther(SWAP_AMOUNT)} ETH → ~${Number(toAmount)/1e8} cbBTC`);
  console.log(`Min output: ${Number(toAmountMin)/1e8} cbBTC`);

  const txData = data.transactionRequest;
  if (!txData) { console.log("❌ No tx data"); return; }

  console.log("\n2. Sending swap...");
  const tx = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: BigInt(txData.value),
    gasLimit: BigInt(txData.gasLimit || 500000),
  });
  console.log(`TX: ${tx.hash}`);
  
  const receipt = await tx.wait();
  console.log(`${receipt!.status === 1 ? "✅ SUCCESS" : "❌ REVERTED"} | Gas: ${receipt!.gasUsed}`);

  // Check cbBTC balance
  const cbbtc = new ethers.Contract(CBBTC, ERC20_ABI, provider);
  const bal = await cbbtc.balanceOf(WALLET);
  console.log(`\ncbBTC balance: ${ethers.formatUnits(bal, 8)} cbBTC`);
  console.log(`ETH remaining: ${ethers.formatEther(await provider.getBalance(WALLET))}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
