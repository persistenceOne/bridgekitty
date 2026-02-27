import { readFileSync } from 'fs';
import { ethers } from 'ethers';

let envContent = '';
try { envContent += readFileSync('.env', 'utf8') + '\n'; } catch {}
try { envContent += readFileSync('.env.acp', 'utf8') + '\n'; } catch {}
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const idx = t.indexOf('=');
  if (idx === -1) continue;
  process.env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
}

const PK = process.env.TEST_BUYER_PRIVATE_KEY;
const ADDR = '0x221726819bcfDDC3B05be56369a14ac836E64B7F';
const signer = new ethers.Wallet(PK);
const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const BTCB = '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { PersistenceBackend } = await import('./dist/backends/persistence.js');
const persistence = new PersistenceBackend();

async function bal(rpc, token, dec) {
  const c = new ethers.Contract(token, erc20Abi, new ethers.JsonRpcProvider(rpc));
  return parseFloat(ethers.formatUnits(await c.balanceOf(ADDR), dec));
}

// First: revoke any stale Permit2 approvals to fix the TRANSFER_FROM_FAILED issue
console.log('=== Revoking stale Permit2 approvals ===');
for (const [rpc, token, name] of [
  ['https://mainnet.base.org', cbBTC, 'cbBTC/Base'],
  ['https://bsc-dataseed1.binance.org', BTCB, 'BTCB/BSC'],
]) {
  const w = signer.connect(new ethers.JsonRpcProvider(rpc));
  const erc20 = new ethers.Contract(token, erc20Abi, w);
  const allowance = await erc20.allowance(ADDR, PERMIT2);
  if (allowance > 0n) {
    console.log(`${name}: revoking Permit2 allowance (${allowance})...`);
    const tx = await erc20.approve(PERMIT2, 0);
    await tx.wait();
    console.log(`${name}: revoked ✅`);
  } else {
    console.log(`${name}: no stale allowance`);
  }
}

let round = 0;
let consecutiveErrors = 0;
console.log('\n=== Running Persistence rounds until out of gas/funds ===\n');

while (consecutiveErrors < 3) {
  round++;
  const cbBTCBal = await bal('https://mainnet.base.org', cbBTC, 8);
  const btcbBal = await bal('https://bsc-dataseed1.binance.org', BTCB, 18);
  console.log(`[${round}] cbBTC=${cbBTCBal.toFixed(8)} | BTCB=${btcbBal.toFixed(8)}`);

  let fromChain, toChain, fromToken, toToken, amountRaw, label;
  const MIN = 0.00005;

  if (cbBTCBal >= MIN) {
    const amt = Math.min(cbBTCBal * 0.90, 0.001);
    amountRaw = BigInt(Math.floor(amt * 1e8)).toString();
    fromChain = 8453; toChain = 56; fromToken = cbBTC; toToken = BTCB;
    label = `${amt.toFixed(8)} cbBTC → BTCB`;
  } else if (btcbBal >= MIN) {
    const amt = Math.min(btcbBal * 0.90, 0.001);
    amountRaw = BigInt(Math.floor(amt * 1e18)).toString();
    fromChain = 56; toChain = 8453; fromToken = BTCB; toToken = cbBTC;
    label = `${amt.toFixed(8)} BTCB → cbBTC`;
  } else {
    console.log(`[${round}] ❌ Both below minimum. Done.`); break;
  }

  console.log(`[${round}] ${label}`);
  try {
    const q = await persistence.getQuote({
      fromChainId: fromChain, toChainId: toChain,
      fromTokenAddress: fromToken, toTokenAddress: toToken,
      amountRaw, fromAddress: ADDR, preference: 'cheapest',
    });
    if (!q) { console.log(`[${round}] ❌ No quote`); consecutiveErrors++; continue; }

    const result = await persistence.signAndExecute(q, signer);
    console.log(`[${round}] ✅ ${result.txHash}`);
    consecutiveErrors = 0;
  } catch (e) {
    console.log(`[${round}] ❌ ${e.message?.slice(0, 150)}`);
    consecutiveErrors++;
  }

  console.log(`Waiting 50s...\n`);
  await sleep(50000);
}

console.log('\n=== Done ===');
console.log(`Rounds attempted: ${round}`);
console.log(`cbBTC: ${(await bal('https://mainnet.base.org', cbBTC, 8)).toFixed(8)}`);
console.log(`BTCB: ${(await bal('https://bsc-dataseed1.binance.org', BTCB, 18)).toFixed(8)}`);
