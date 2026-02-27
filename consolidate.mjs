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
  const key = t.slice(0, idx).trim();
  let val = t.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    val = val.slice(1, -1);
  process.env[key] = val;
}

const PK = process.env.TEST_BUYER_PRIVATE_KEY;
const ADDR = '0x221726819bcfDDC3B05be56369a14ac836E64B7F';

const { AcrossBackend } = await import('./dist/backends/across.js');
const { RelayBackend } = await import('./dist/backends/relay.js');
const { LiFiBackend } = await import('./dist/backends/lifi.js');

const across = new AcrossBackend();
const relay = new RelayBackend();
const lifi = new LiFiBackend();

const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const arbUSDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const opUSDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wallet(chainId) {
  const rpcs = {
    8453: 'https://mainnet.base.org',
    42161: 'https://arb1.arbitrum.io/rpc',
    10: 'https://mainnet.optimism.io',
    56: 'https://bsc-dataseed1.binance.org',
  };
  return new ethers.Wallet(PK, new ethers.JsonRpcProvider(rpcs[chainId]));
}

async function bridgeUSDC(fromChainId, toChainId, fromToken, toToken, amount, label) {
  console.log(`\n=== ${label} ===`);
  const amountRaw = (BigInt(Math.floor(amount * 1e6))).toString();
  console.log(`Bridging ${amount} USDC (${amountRaw} raw)`);

  // Try multiple backends
  const backends = [relay, across, lifi];
  const names = ['Relay', 'Across', 'LiFi'];
  let bestQuote = null;
  let bestName = '';
  let bestBackend = null;

  for (let i = 0; i < backends.length; i++) {
    try {
      const q = await backends[i].getQuote({
        fromChainId, toChainId,
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amountRaw,
        fromAddress: ADDR,
        toAddress: ADDR,
        preference: 'cheapest',
      });
      if (q) {
        console.log(`${names[i]}: ${q.outputAmount} USDC`);
        if (!bestQuote || parseFloat(q.outputAmount) > parseFloat(bestQuote.outputAmount)) {
          bestQuote = q;
          bestName = names[i];
          bestBackend = backends[i];
        }
      }
    } catch (e) { console.log(`${names[i]}: error - ${e.message}`); }
  }

  if (!bestQuote) { console.log('❌ No quotes'); return; }
  console.log(`Best: ${bestName} → ${bestQuote.outputAmount} USDC`);

  const tx = await bestBackend.buildTransaction(bestQuote);
  const w = wallet(fromChainId);

  // Handle approval
  if (tx.approvalTx) {
    const erc20 = new ethers.Contract(fromToken, erc20Abi, w);
    const allowance = await erc20.allowance(ADDR, tx.to);
    if (allowance < BigInt(amountRaw)) {
      console.log('Sending approval...');
      const appTx = await w.sendTransaction({ to: tx.approvalTx.to, data: tx.approvalTx.data, value: tx.approvalTx.value });
      await appTx.wait();
      console.log('Approved ✅');

      // Re-fetch if needed (Squid nonce fix)
      if (tx.needsPostApprovalBuild && bestBackend.buildBridgeTransaction) {
        const freshTx = await bestBackend.buildBridgeTransaction(bestQuote);
        Object.assign(tx, freshTx);
      }
    }
  }

  console.log('Sending bridge tx...');
  const bridgeTx = await w.sendTransaction({
    to: tx.to, data: tx.data, value: tx.value,
    ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
  });
  console.log(`Tx: ${bridgeTx.hash}`);
  await bridgeTx.wait();
  console.log('Confirmed ✅');
  return bridgeTx.hash;
}

// Step 1: OP USDC → Base USDC
await bridgeUSDC(10, 8453, opUSDC, baseUSDC, 0.69, 'OP → Base USDC');
await sleep(5000);

// Step 2: Arb USDC → Base USDC
await bridgeUSDC(42161, 8453, arbUSDC, baseUSDC, 0.38, 'Arb → Base USDC');

console.log('\nWaiting 30s for bridges to complete...');
await sleep(30000);

// Check Base USDC balance
const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const usdc = new ethers.Contract(baseUSDC, erc20Abi, baseProvider);
const bal = await usdc.balanceOf(ADDR);
console.log(`\nBase USDC balance: ${ethers.formatUnits(bal, 6)}`);
console.log('\n=== Consolidation complete ===');
