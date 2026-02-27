/**
 * Check balances on all major EVM chains
 */
import { ethers } from "ethers";

const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const CHAINS = [
  { name: "Ethereum", rpc: "https://eth.llamarpc.com", native: "ETH",
    usdc: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 },
    usdt: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6 } },
  { name: "Optimism", rpc: "https://mainnet.optimism.io", native: "ETH",
    usdc: { addr: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", dec: 6 },
    usdt: { addr: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", dec: 6 } },
  { name: "Arbitrum", rpc: "https://arb1.arbitrum.io/rpc", native: "ETH",
    usdc: { addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", dec: 6 },
    usdt: { addr: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", dec: 6 } },
  { name: "Base", rpc: "https://mainnet.base.org", native: "ETH",
    usdc: { addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dec: 6 },
    usdt: null },
  { name: "Polygon", rpc: "https://polygon-bor-rpc.publicnode.com", native: "POL",
    usdc: { addr: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", dec: 6 },
    usdt: { addr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", dec: 6 } },
  { name: "BSC", rpc: "https://bsc-dataseed.binance.org", native: "BNB",
    usdc: { addr: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", dec: 18 },
    usdt: { addr: "0x55d398326f99059fF775485246999027B3197955", dec: 18 } },
  { name: "Avalanche", rpc: "https://api.avax.network/ext/bc/C/rpc", native: "AVAX",
    usdc: { addr: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", dec: 6 },
    usdt: { addr: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", dec: 6 } },
];

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
}

async function main() {
  console.log(`Wallet: ${WALLET}\n`);

  const rows: string[] = [];
  
  for (const chain of CHAINS) {
    const provider = new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true });
    
    const nativeBal = await withTimeout(
      provider.getBalance(WALLET).then(b => ethers.formatEther(b)),
      8000, "timeout"
    );

    const usdcBal = await withTimeout(
      new ethers.Contract(chain.usdc.addr, ERC20_ABI, provider)
        .balanceOf(WALLET).then((b: bigint) => ethers.formatUnits(b, chain.usdc.dec)),
      8000, "timeout"
    );

    const usdtBal = chain.usdt
      ? await withTimeout(
          new ethers.Contract(chain.usdt.addr, ERC20_ABI, provider)
            .balanceOf(WALLET).then((b: bigint) => ethers.formatUnits(b, chain.usdt!.dec)),
          8000, "timeout"
        )
      : "N/A";

    const row = `| ${chain.name} | ${nativeBal} ${chain.native} | ${usdcBal} USDC | ${usdtBal === "N/A" ? "N/A" : usdtBal + " USDT"} |`;
    rows.push(row);
    console.log(`${chain.name}: ${nativeBal} ${chain.native} | ${usdcBal} USDC | ${usdtBal} USDT`);
  }

  console.log("\n--- Markdown ---");
  console.log("| Chain | Native | USDC | USDT |");
  console.log("|-------|--------|------|------|");
  rows.forEach(r => console.log(r));
}

main().catch(e => { console.error(e); process.exit(1); });
