import { readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { SquidBackend } from './dist/backends/squid.js';
import { LiFiBackend } from './dist/backends/lifi.js';
import { AcrossBackend } from './dist/backends/across.js';
import { DeBridgeBackend } from './dist/backends/debridge.js';

// Load .env
const envLines = readFileSync('.env', 'utf8').split('\n');
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WALLET_ADDRESS = '0x221726819bcfDDC3B05be56369a14ac836E64B7F';

const RPC = {
  8453: 'https://base-rpc.publicnode.com',
  56: 'https://bsc-dataseed.binance.org/',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

function prov(chainId) { return new ethers.JsonRpcProvider(RPC[chainId]); }
function wall(chainId) { return new ethers.Wallet(PRIVATE_KEY, prov(chainId)); }

async function getBalance(chainId, tokenAddress) {
  const p = prov(chainId);
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return await p.getBalance(WALLET_ADDRESS);
  }
  return await new ethers.Contract(tokenAddress, ERC20_ABI, p).balanceOf(WALLET_ADDRESS);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForBalance(chainId, tokenAddress, beforeBal, timeoutSec = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const bal = await getBalance(chainId, tokenAddress);
    if (bal > beforeBal) return bal;
    console.log(`  Waiting... (${Math.round((Date.now()-start)/1000)}s)`);
    await sleep(10000);
  }
  return await getBalance(chainId, tokenAddress);
}

async function sendApprovalIfNeeded(tx, chainId) {
  if (!tx.approvalTx) return;
  console.log(`  Approval tx target: ${tx.approvalTx.to}`);
  // Send the approvalTx as-is (it's a pre-built approve call on the token contract)
  const w = wall(chainId);
  const sent = await w.sendTransaction({
    to: tx.approvalTx.to,
    data: tx.approvalTx.data,
    value: tx.approvalTx.value || '0x0',
    gasLimit: 200000,
  });
  console.log(`  Approval tx hash: ${sent.hash}`);
  await sent.wait();
  console.log(`  Approved.`);
}

const results = [];
function log(msg) { console.log(msg); results.push(msg); }

async function runTest(name, fn) {
  log(`\n${'='.repeat(60)}`);
  log(`=== ${name} ===`);
  log('='.repeat(60));
  try {
    await fn();
    log(`✅ ${name} — SUCCESS`);
  } catch (e) {
    log(`❌ ${name} — FAILED: ${e.message?.slice(0,200)}`);
    console.error(e);
  }
}

// ============================================================
// TEST 1: Squid — check integrator ID
// ============================================================
await runTest('TEST 1: Squid (Base USDC → OP USDC, 0.50 USDC)', async () => {
  // Try different integrator IDs
  for (const intId of ['squid-swap-widget', 'bridgekitty']) {
    console.log(`  Trying integrator: ${intId}`);
    const backend = new SquidBackend(intId);
    try {
      const quote = await backend.getQuote({
        fromChainId: 8453, toChainId: 10,
        fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        toTokenAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        amountRaw: '500000', fromAddress: WALLET_ADDRESS,
        preference: 'cheapest',
      });
      if (quote) {
        log(`  Quote with '${intId}': output=${quote.outputAmount}`);
        
        const destToken = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
        const beforeBal = await getBalance(10, destToken);
        log(`  Before (OP USDC): ${ethers.formatUnits(beforeBal, 6)}`);
        
        const tx = await backend.buildTransaction(quote);
        log(`  TX to: ${tx.to}, value: ${tx.value}`);
        
        await sendApprovalIfNeeded(tx, 8453);
        
        const w = wall(8453);
        const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
        log(`  TX hash: ${sent.hash}`);
        await sent.wait();
        
        const afterBal = await waitForBalance(10, destToken, beforeBal, 120);
        log(`  After (OP USDC): ${ethers.formatUnits(afterBal, 6)}`);
        log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
        return;
      }
    } catch (e) {
      console.log(`  Failed with '${intId}': ${e.message?.slice(0,100)}`);
    }
  }
  throw new Error('All Squid integrator IDs failed');
});

// ============================================================
// TEST 2: LI.FI swap — Base USDC → Base ETH (fix: send approvalTx directly)
// ============================================================
await runTest('TEST 2: LI.FI Swap (Base USDC → Base ETH, 2.00 USDC)', async () => {
  const backend = new LiFiBackend();
  const beforeBal = await getBalance(8453, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  log(`  Before (Base ETH): ${ethers.formatEther(beforeBal)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 8453,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    amountRaw: '2000000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, route=${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, data length: ${tx.data?.length}, value: ${tx.value}`);

  await sendApprovalIfNeeded(tx, 8453);

  const w = wall(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  await sleep(3000);
  const afterBal = await getBalance(8453, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  log(`  After (Base ETH): ${ethers.formatEther(afterBal)}`);
  log(`  Received: ${ethers.formatEther(afterBal - beforeBal)} ETH (net of gas)`);
});

// ============================================================
// TEST 3: Across — use WETH address for Base
// ============================================================
await runTest('TEST 3: Across (Base ETH → Arb ETH, 0.001 ETH)', async () => {
  const backend = new AcrossBackend(process.env.ACROSS_REFERRAL_ADDRESS);
  
  // Check what tokens Across supports on Base
  const tokens = await backend.getSupportedTokens?.(8453);
  if (tokens) {
    const ethTokens = tokens.filter(t => t.symbol.includes('ETH') || t.symbol === 'WETH');
    console.log('  Across ETH tokens on Base:', ethTokens.map(t => `${t.symbol}=${t.address}`));
  }

  // Try with WETH address
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
  
  const destToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  const beforeBal = await getBalance(42161, destToken);
  log(`  Before (Arb ETH): ${ethers.formatEther(beforeBal)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: WETH_BASE,
    toTokenAddress: WETH_ARB,
    amountRaw: '1000000000000000', fromAddress: WALLET_ADDRESS,
    preference: 'fastest',
  });
  if (!quote) throw new Error('Across returned null quote');
  log(`  Quote: output=${quote.outputAmount}, route=${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}`);

  // For native ETH bridging via Across, value should include the amount
  const w = wall(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(42161, destToken, beforeBal, 120);
  log(`  After (Arb ETH): ${ethers.formatEther(afterBal)}`);
  log(`  Received: ${ethers.formatEther(afterBal - beforeBal)} ETH`);
});

// ============================================================
// TEST 4: LI.FI bridge — Base USDC → Arb USDC (fix approval)
// ============================================================
await runTest('TEST 4: LI.FI Bridge (Base USDC → Arb USDC, 1.00 USDC)', async () => {
  const backend = new LiFiBackend();
  const destToken = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const beforeBal = await getBalance(42161, destToken);
  log(`  Before (Arb USDC): ${ethers.formatUnits(beforeBal, 6)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: destToken,
    amountRaw: '1000000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, route=${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, data length: ${tx.data?.length}, value: ${tx.value}`);

  await sendApprovalIfNeeded(tx, 8453);

  const w = wall(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(42161, destToken, beforeBal, 120);
  log(`  After (Arb USDC): ${ethers.formatUnits(afterBal, 6)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
});

// ============================================================
// TEST 5: deBridge — Arb USDC → Base USDC (check if we have enough ETH now)
// ============================================================
await runTest('TEST 5: deBridge (Arb USDC → Base USDC, 0.50 USDC)', async () => {
  const arbEth = await getBalance(42161, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  log(`  Arb ETH balance: ${ethers.formatEther(arbEth)}`);
  
  const backend = new DeBridgeBackend(process.env.DEBRIDGE_AFFILIATE_FEE, process.env.DEBRIDGE_AFFILIATE_ADDRESS);
  const destToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const beforeBal = await getBalance(8453, destToken);
  log(`  Before (Base USDC): ${ethers.formatUnits(beforeBal, 6)}`);

  const quote = await backend.getQuote({
    fromChainId: 42161, toChainId: 8453,
    fromTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    toTokenAddress: destToken,
    amountRaw: '500000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, route=${quote.route}`);
  log(`  Protocol fee value: ${quote.quoteData?.value || 'unknown'}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value} (${ethers.formatEther(tx.value)} ETH)`);

  // Check if we have enough ETH for value + gas
  const needed = BigInt(tx.value) + BigInt(500000 * 100000000); // rough gas estimate
  log(`  Need ~${ethers.formatEther(needed)} ETH, have ${ethers.formatEther(arbEth)}`);
  
  if (arbEth < needed) {
    log(`  ⚠️ Insufficient ETH on Arb for deBridge protocol fee`);
    throw new Error(`Insufficient Arb ETH: have ${ethers.formatEther(arbEth)}, need ~${ethers.formatEther(needed)}`);
  }

  await sendApprovalIfNeeded(tx, 42161);

  const w = wall(42161);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(8453, destToken, beforeBal, 120);
  log(`  After (Base USDC): ${ethers.formatUnits(afterBal, 6)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
});

// Save
log(`\n${'='.repeat(60)}`);
log('E2E RE-RUN COMPLETE');
log(`Timestamp: ${new Date().toISOString()}`);
log('='.repeat(60));

// Append to results file
const existing = readFileSync('test-e2e-results-round2.md', 'utf8');
writeFileSync('test-e2e-results-round2.md', existing + `\n\n## Re-run (fixes)\n\n\`\`\`\n${results.join('\n')}\n\`\`\`\n`);
console.log('\nResults appended to test-e2e-results-round2.md');
