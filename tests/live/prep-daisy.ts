import { ethers } from "ethers";
import * as fs from "fs";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import { getProvider } from "../../src/utils/gas-estimator.js";

const envPath = process.env.HOME + "/.bridgekitty/.env";
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i > 0) process.env[t.slice(0,i).trim()] = t.slice(i+1).trim();
}

const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const persistence = new PersistenceBackend();
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!);
  console.log(`Wallet: ${signer.address}`);

  // Check BTCB on BSC
  const bscP = await getProvider(56);
  const btcbBal = await new ethers.Contract(BTCB_BSC, ERC20_ABI, bscP).balanceOf(signer.address);
  console.log(`BTCB on BSC: ${Number(btcbBal)/1e18}`);
  
  if (btcbBal < 5000n * (10n**10n)) { console.log("Not enough BTCB"); return; }

  // Bridge BTCB → cbBTC
  console.log(`\nBridging BTCB → cbBTC...`);
  const q = await persistence.getQuote({
    fromChainId: 56, toChainId: 8453,
    fromTokenAddress: BTCB_BSC, toTokenAddress: CBBTC_BASE,
    amountRaw: btcbBal.toString(), fromAddress: signer.address, preference: "cheapest"
  });
  if (!q) { console.log("No quote!"); return; }
  console.log(`Quote: ${q.outputAmount} cbBTC`);

  const signerBsc = signer.connect(bscP);
  const r = await persistence.signAndExecute(q, signerBsc);
  console.log(`Source tx: ${r.txHash}`);
  console.log(`Waiting for fill...`);

  // Wait for cbBTC
  const baseP = await getProvider(8453);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    const bal = await new ethers.Contract(CBBTC_BASE, ERC20_ABI, baseP).balanceOf(signer.address);
    if (bal > 0n) { console.log(`✅ Got ${Number(bal)/1e8} cbBTC on Base!`); return; }
    await new Promise(r => setTimeout(r, 5000));
    console.log(`  polling... ${((Date.now()-start)/1000).toFixed(0)}s`);
  }
  console.log("Timeout");
}
main().catch(e => console.error(e));
