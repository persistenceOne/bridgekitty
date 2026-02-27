import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { SquidBackend } from './dist/backends/squid.js';
import { LiFiBackend } from './dist/backends/lifi.js';
import { AcrossBackend } from './dist/backends/across.js';
import { DeBridgeBackend } from './dist/backends/debridge.js';
import { PersistenceBackend } from './dist/backends/persistence.js';

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
  'function decimals() view returns (uint8)',
];

function provider(chainId) { return new ethers.JsonRpcProvider(RPC[chainId]); }
function wallet(chainId) { return new ethers.Wallet(PRIVATE_KEY, provider(chainId)); }

async function getBalance(chainId, tokenAddress) {
  const p = provider(chainId);
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return await p.getBalance(WALLET_ADDRESS);
  }
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, p);
  return await c.balanceOf(WALLET_ADDRESS);
}

async function checkAndApprove(chainId, tokenAddress, spender, amountRaw) {
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return;
  const w = wallet(chainId);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, w);
  const allowance = await c.allowance(WALLET_ADDRESS, spender);
  if (allowance >= BigInt(amountRaw)) {
    console.log(`  Allowance sufficient: ${allowance}`);
    return;
  }
  console.log(`  Approving ${spender}...`);
  const tx = await c.approve(spender, amountRaw, { gasLimit: 200000 });
  console.log(`  Approval tx: ${tx.hash}`);
  await tx.wait();
  console.log(`  Approved.`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForBalance(chainId, tokenAddress, beforeBal, timeoutSec = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const bal = await getBalance(chainId, tokenAddress);
    if (bal > beforeBal) {
      return bal;
    }
    console.log(`  Waiting for balance change... (${Math.round((Date.now()-start)/1000)}s)`);
    await sleep(10000);
  }
  return await getBalance(chainId, tokenAddress);
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
    log(`❌ ${name} — FAILED: ${e.message}`);
    console.error(e);
  }
}

// ============================================================
// TEST 1: Squid — Base USDC → OP USDC
// ============================================================
await runTest('TEST 1: Squid (Base USDC → OP USDC, 0.50 USDC)', async () => {
  const backend = new SquidBackend('squid-swap-widget');
  const destToken = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
  const beforeBal = await getBalance(10, destToken);
  log(`  Before balance (OP USDC): ${ethers.formatUnits(beforeBal, 6)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 10,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: destToken,
    amountRaw: '500000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}, chainId: ${tx.chainId}`);

  if (tx.approvalTx) {
    log(`  Approval needed: ${tx.approvalTx.to}`);
    await checkAndApprove(tx.approvalTx.chainId || 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tx.approvalTx.to, '500000');
  }

  const w = wallet(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(10, destToken, beforeBal, 120);
  log(`  After balance (OP USDC): ${ethers.formatUnits(afterBal, 6)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
});

// ============================================================
// TEST 2: LI.FI same-chain swap — Base USDC → Base ETH
// ============================================================
await runTest('TEST 2: LI.FI Swap (Base USDC → Base ETH, 2.00 USDC)', async () => {
  const backend = new LiFiBackend();
  const beforeBal = await getBalance(8453, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  log(`  Before balance (Base ETH): ${ethers.formatEther(beforeBal)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 8453,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    amountRaw: '2000000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}, chainId: ${tx.chainId}`);

  if (tx.approvalTx) {
    log(`  Approval needed: ${tx.approvalTx.to}`);
    await checkAndApprove(tx.approvalTx.chainId || 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tx.approvalTx.to, '2000000');
  }

  const w = wallet(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  // Same chain, should be instant
  await sleep(3000);
  const afterBal = await getBalance(8453, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  log(`  After balance (Base ETH): ${ethers.formatEther(afterBal)}`);
  log(`  Received: ${ethers.formatEther(afterBal - beforeBal)} ETH (net of gas)`);
});

// ============================================================
// TEST 3: Across — Base ETH → Arb ETH
// ============================================================
await runTest('TEST 3: Across (Base ETH → Arb ETH, 0.001 ETH)', async () => {
  const backend = new AcrossBackend(process.env.ACROSS_REFERRAL_ADDRESS);
  const destToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  const beforeBal = await getBalance(42161, destToken);
  log(`  Before balance (Arb ETH): ${ethers.formatEther(beforeBal)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    toTokenAddress: destToken,
    amountRaw: '1000000000000000', fromAddress: WALLET_ADDRESS,
    preference: 'fastest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}, chainId: ${tx.chainId}`);

  const w = wallet(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(42161, destToken, beforeBal, 120);
  log(`  After balance (Arb ETH): ${ethers.formatEther(afterBal)}`);
  log(`  Received: ${ethers.formatEther(afterBal - beforeBal)} ETH`);
});

// ============================================================
// TEST 4: LI.FI bridge — Base USDC → Arb USDC
// ============================================================
await runTest('TEST 4: LI.FI Bridge (Base USDC → Arb USDC, 1.00 USDC)', async () => {
  const backend = new LiFiBackend();
  const destToken = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const beforeBal = await getBalance(42161, destToken);
  log(`  Before balance (Arb USDC): ${ethers.formatUnits(beforeBal, 6)}`);

  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: destToken,
    amountRaw: '1000000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}, chainId: ${tx.chainId}`);

  if (tx.approvalTx) {
    log(`  Approval needed: ${tx.approvalTx.to}`);
    await checkAndApprove(tx.approvalTx.chainId || 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tx.approvalTx.to, '1000000');
  }

  const w = wallet(8453);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(42161, destToken, beforeBal, 120);
  log(`  After balance (Arb USDC): ${ethers.formatUnits(afterBal, 6)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
});

// ============================================================
// TEST 5: deBridge — Arb USDC → Base USDC
// ============================================================
await runTest('TEST 5: deBridge (Arb USDC → Base USDC, 0.50 USDC)', async () => {
  const backend = new DeBridgeBackend(process.env.DEBRIDGE_AFFILIATE_FEE, process.env.DEBRIDGE_AFFILIATE_ADDRESS);
  const destToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const beforeBal = await getBalance(8453, destToken);
  log(`  Before balance (Base USDC): ${ethers.formatUnits(beforeBal, 6)}`);

  const quote = await backend.getQuote({
    fromChainId: 42161, toChainId: 8453,
    fromTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    toTokenAddress: destToken,
    amountRaw: '500000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const tx = await backend.buildTransaction(quote);
  log(`  TX to: ${tx.to}, value: ${tx.value}, chainId: ${tx.chainId}`);

  if (tx.approvalTx) {
    log(`  Approval needed: ${tx.approvalTx.to}`);
    await checkAndApprove(tx.approvalTx.chainId || 42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', tx.approvalTx.to, '500000');
  }

  const w = wallet(42161);
  const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 500000 });
  log(`  TX hash: ${sent.hash}`);
  const receipt = await sent.wait();
  log(`  Confirmed block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}`);

  const afterBal = await waitForBalance(8453, destToken, beforeBal, 120);
  log(`  After balance (Base USDC): ${ethers.formatUnits(afterBal, 6)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
});

// ============================================================
// TEST 6: Persistence — BSC BTCB → Base cbBTC
// ============================================================
await runTest('TEST 6: Persistence (BSC BTCB → Base cbBTC, 0.00005 BTCB)', async () => {
  const backend = new PersistenceBackend();
  const destToken = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
  const beforeBal = await getBalance(8453, destToken);
  log(`  Before balance (Base cbBTC): ${ethers.formatUnits(beforeBal, 8)}`);

  const quote = await backend.getQuote({
    fromChainId: 56, toChainId: 8453,
    fromTokenAddress: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    toTokenAddress: destToken,
    amountRaw: '50000000000000', fromAddress: WALLET_ADDRESS,
    preference: 'cheapest',
  });
  log(`  Quote: output=${quote.outputAmount}, fee=$${quote.feeBreakdown.totalFeeUsd}, time=${quote.estimatedTimeSeconds}s`);
  log(`  Route: ${quote.route}`);

  const signer = new ethers.Wallet(PRIVATE_KEY);
  const result = await backend.signAndExecute(quote, signer);
  log(`  TX hash: ${result.txHash}`);
  log(`  Order ID: ${result.orderId}`);
  log(`  Tracking ID: ${result.trackingId}`);

  const afterBal = await waitForBalance(8453, destToken, beforeBal, 180);
  log(`  After balance (Base cbBTC): ${ethers.formatUnits(afterBal, 8)}`);
  log(`  Received: ${ethers.formatUnits(afterBal - beforeBal, 8)} cbBTC`);
});

// Save results
log(`\n${'='.repeat(60)}`);
log('E2E TEST RUN COMPLETE');
log(`Timestamp: ${new Date().toISOString()}`);
log('='.repeat(60));

writeFileSync('test-e2e-results-round2.md', `# BridgeKitty E2E Test Results — Round 2\n\n\`\`\`\n${results.join('\n')}\n\`\`\`\n`);
console.log('\nResults saved to test-e2e-results-round2.md');
