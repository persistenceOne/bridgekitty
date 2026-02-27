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
const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const BTCB = '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c';
const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { PersistenceBackend } = await import('./dist/backends/persistence.js');
const persistence = new PersistenceBackend();

function wallet(rpc) { return new ethers.Wallet(PK, new ethers.JsonRpcProvider(rpc)); }
async function bal(rpc, token, dec) {
  const c = new ethers.Contract(token, erc20Abi, new ethers.JsonRpcProvider(rpc));
  return parseFloat(ethers.formatUnits(await c.balanceOf(ADDR), dec));
}

const ROUNDS = 4;
console.log(`=== ${ROUNDS} Persistence Rounds (cbBTC↔BTCB) ===\n`);

for (let i = 1; i <= ROUNDS; i++) {
  const cbBTCBal = await bal('https://mainnet.base.org', cbBTC, 8);
  const btcbBal = await bal('https://bsc-dataseed1.binance.org', BTCB, 18);
  console.log(`Balances: cbBTC=${cbBTCBal.toFixed(8)} | BTCB=${btcbBal.toFixed(8)}`);

  let fromChain, toChain, fromToken, toToken, amountRaw, rpc, label;

  if (cbBTCBal >= 0.00006) {
    const amt = Math.min(cbBTCBal * 0.85, 0.001);
    amountRaw = BigInt(Math.floor(amt * 1e8)).toString();
    fromChain = 8453; toChain = 56; fromToken = cbBTC; toToken = BTCB;
    rpc = 'https://mainnet.base.org';
    label = `Round ${i}: ${amt.toFixed(8)} cbBTC → BTCB`;
  } else if (btcbBal >= 0.00006) {
    const amt = Math.min(btcbBal * 0.85, 0.001);
    amountRaw = BigInt(Math.floor(amt * 1e18)).toString();
    fromChain = 56; toChain = 8453; fromToken = BTCB; toToken = cbBTC;
    rpc = 'https://bsc-dataseed1.binance.org';
    label = `Round ${i}: ${amt.toFixed(8)} BTCB → cbBTC`;
  } else {
    console.log(`Round ${i}: ❌ Not enough on either chain`); break;
  }

  console.log(label);
  try {
    const q = await persistence.getQuote({
      fromChainId: fromChain, toChainId: toChain,
      fromTokenAddress: fromToken, toTokenAddress: toToken,
      amountRaw, fromAddress: ADDR, preference: 'cheapest',
    });
    if (!q) { console.log('❌ No quote\n'); continue; }
    console.log(`Quote: ${q.outputAmount}`);

    const tx = await persistence.buildTransaction(q);
    const w = wallet(rpc);
    if (tx.approvalTx) {
      const a = await w.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: tx.approvalTx.value });
      await a.wait(); console.log('Approved ✅');
    }
    const b = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}) });
    console.log(`Tx: ${b.hash}`);
    await b.wait(); console.log('Confirmed ✅');
  } catch (e) {
    console.log(`❌ Error: ${e.message?.slice(0, 150)}`);
  }

  if (i < ROUNDS) { console.log('Waiting 50s...\n'); await sleep(50000); }
}

console.log('\n=== Final Balances ===');
console.log(`cbBTC: ${(await bal('https://mainnet.base.org', cbBTC, 8)).toFixed(8)}`);
console.log(`BTCB: ${(await bal('https://bsc-dataseed1.binance.org', BTCB, 18)).toFixed(8)}`);
