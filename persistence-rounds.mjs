import { readFileSync } from 'fs';
import { ethers } from 'ethers';

// Load env
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
const baseRpc = 'https://mainnet.base.org';
const bscRpc = 'https://bsc-dataseed1.binance.org';
const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const BTCB = '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c';
const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const { PersistenceBackend } = await import('./dist/backends/persistence.js');
const { LiFiBackend } = await import('./dist/backends/lifi.js');
const persistence = new PersistenceBackend();
const lifi = new LiFiBackend();

function wallet(rpc) { return new ethers.Wallet(PK, new ethers.JsonRpcProvider(rpc)); }

async function getBalance(rpc, token, decimals) {
  const p = new ethers.JsonRpcProvider(rpc);
  const c = new ethers.Contract(token, erc20Abi, p);
  return ethers.formatUnits(await c.balanceOf(ADDR), decimals);
}

// Step 1: Swap ~5 USDC → cbBTC on Base via LiFi
console.log('=== Step 1: Swap 5 USDC → cbBTC on Base ===');
const swapQuote = await lifi.getQuote({
  fromChainId: 8453, toChainId: 8453,
  fromTokenAddress: baseUSDC, toTokenAddress: cbBTC,
  amountRaw: '5000000', // 5 USDC
  fromAddress: ADDR, preference: 'cheapest',
});
if (swapQuote) {
  console.log(`Quote: ${swapQuote.outputAmount} cbBTC`);
  const tx = await lifi.buildTransaction(swapQuote);
  const w = wallet(baseRpc);
  if (tx.approvalTx) {
    const appTx = await w.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: tx.approvalTx.value });
    await appTx.wait();
    console.log('Approved ✅');
  }
  const swapTx = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  console.log(`Swap tx: ${swapTx.hash}`);
  await swapTx.wait();
  console.log('Swap confirmed ✅');
} else {
  console.log('No swap quote — skipping');
}

await sleep(3000);
console.log(`cbBTC balance: ${await getBalance(baseRpc, cbBTC, 8)}`);
console.log(`BTCB balance: ${await getBalance(bscRpc, BTCB, 18)}`);

// Step 2: Persistence bridge rounds
const ROUNDS = 4;
console.log(`\n=== Step 2: ${ROUNDS} Persistence Bridge Rounds ===`);

for (let i = 1; i <= ROUNDS; i++) {
  // Determine direction based on balances
  const cbBTCBal = parseFloat(await getBalance(baseRpc, cbBTC, 8));
  const btcbBal = parseFloat(await getBalance(bscRpc, BTCB, 18));
  
  let fromChain, toChain, fromToken, toToken, amount, label;
  if (cbBTCBal >= 0.00005) {
    // Bridge cbBTC → BTCB (Base → BSC)
    amount = Math.min(cbBTCBal * 0.9, 0.001); // 90% of balance, max 0.001
    const amountRaw = BigInt(Math.floor(amount * 1e8)).toString();
    fromChain = 8453; toChain = 56;
    fromToken = cbBTC; toToken = BTCB;
    label = `Round ${i}: cbBTC(Base) → BTCB(BSC) — ${amount.toFixed(8)}`;
    console.log(`\n${label}`);
    
    const q = await persistence.getQuote({
      fromChainId: fromChain, toChainId: toChain,
      fromTokenAddress: fromToken, toTokenAddress: toToken,
      amountRaw, fromAddress: ADDR, preference: 'cheapest',
    });
    if (!q) { console.log('❌ No quote'); continue; }
    console.log(`Quote: receive ${q.outputAmount} BTCB`);
    
    const tx = await persistence.buildTransaction(q);
    const w = wallet(baseRpc);
    if (tx.approvalTx) {
      const appTx = await w.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: tx.approvalTx.value });
      await appTx.wait();
      console.log('Approved ✅');
    }
    const bridgeTx = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}) });
    console.log(`Tx: ${bridgeTx.hash}`);
    await bridgeTx.wait();
    console.log('Confirmed ✅');
    
  } else if (btcbBal >= 0.00005) {
    // Bridge BTCB → cbBTC (BSC → Base)
    amount = Math.min(btcbBal * 0.9, 0.001);
    // BTCB is 18 decimals
    const amountRaw = BigInt(Math.floor(amount * 1e18)).toString();
    fromChain = 56; toChain = 8453;
    fromToken = BTCB; toToken = cbBTC;
    label = `Round ${i}: BTCB(BSC) → cbBTC(Base) — ${amount.toFixed(8)}`;
    console.log(`\n${label}`);
    
    const q = await persistence.getQuote({
      fromChainId: fromChain, toChainId: toChain,
      fromTokenAddress: fromToken, toTokenAddress: toToken,
      amountRaw, fromAddress: ADDR, preference: 'cheapest',
    });
    if (!q) { console.log('❌ No quote'); continue; }
    console.log(`Quote: receive ${q.outputAmount} cbBTC`);
    
    const tx = await persistence.buildTransaction(q);
    const w = wallet(bscRpc);
    if (tx.approvalTx) {
      const appTx = await w.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: tx.approvalTx.value });
      await appTx.wait();
      console.log('Approved ✅');
    }
    const bridgeTx = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}) });
    console.log(`Tx: ${bridgeTx.hash}`);
    await bridgeTx.wait();
    console.log('Confirmed ✅');
    
  } else {
    console.log(`Round ${i}: ❌ Insufficient balance on both chains`);
    break;
  }
  
  // Wait for bridge settlement
  console.log('Waiting 45s for settlement...');
  await sleep(45000);
}

// Final balances
console.log('\n=== Final Balances ===');
console.log(`Base cbBTC: ${await getBalance(baseRpc, cbBTC, 8)}`);
console.log(`BSC BTCB: ${await getBalance(bscRpc, BTCB, 18)}`);
console.log(`Base USDC: ${await getBalance(baseRpc, baseUSDC, 6)}`);
