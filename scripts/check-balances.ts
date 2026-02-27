import { ethers } from "ethers";
const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const USDC_ADDRS: Record<string, string> = {
  "Arbitrum": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "Base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "Optimism": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};
const RPCS: Record<string, string> = {
  "Arbitrum": "https://arb1.arbitrum.io/rpc",
  "Base": "https://mainnet.base.org",
  "Optimism": "https://mainnet.optimism.io",
};
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  for (const [chain, rpc] of Object.entries(RPCS)) {
    const p = new ethers.JsonRpcProvider(rpc);
    const eth = await p.getBalance(WALLET);
    const usdc = new ethers.Contract(USDC_ADDRS[chain], ERC20_ABI, p);
    const usdcBal = await usdc.balanceOf(WALLET);
    console.log(`${chain}: ${ethers.formatEther(eth)} ETH, ${ethers.formatUnits(usdcBal, 6)} USDC`);
  }
}
main().catch(console.error);
