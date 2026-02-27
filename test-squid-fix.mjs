import { readFileSync } from 'fs';
import { ethers } from 'ethers';

// Load .env
let envContent = '';
try { envContent += readFileSync('.env', 'utf8') + '\n'; } catch {}
try { envContent += readFileSync('.env.acp', 'utf8') + '\n'; } catch {}
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  let val = trimmed.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    val = val.slice(1, -1);
  process.env[key] = val;
}

const { SquidBackend } = await import('./dist/backends/squid.js');

const PK = process.env.TEST_BUYER_PRIVATE_KEY;
if (!PK) throw new Error('No TEST_BUYER_PRIVATE_KEY');
const WALLET_ADDR = new ethers.Wallet(PK).address;

const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(PK, baseProvider);

const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const opUSDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';

const squid = new SquidBackend();

console.log('=== Squid Nonce Fix Test ===');
console.log(`Wallet: ${WALLET_ADDR}`);

// Check USDC balance
const erc20 = new ethers.Contract(baseUSDC, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], baseProvider);
const bal = await erc20.balanceOf(WALLET_ADDR);
console.log(`Base USDC balance: ${ethers.formatUnits(bal, 6)}`);

if (bal < 200000n) {
  console.log('Not enough USDC (need 0.2). Trying with 0.1...');
}

const amount = bal < 500000n ? '100000' : '500000'; // 0.1 or 0.5 USDC
console.log(`Bridging ${ethers.formatUnits(amount, 6)} USDC Base → OP`);

// Get quote
const quote = await squid.getQuote({
  fromChainId: 8453,
  toChainId: 10,
  fromTokenAddress: baseUSDC,
  toTokenAddress: opUSDC,
  amountRaw: amount,
  fromAddress: WALLET_ADDR,
  toAddress: WALLET_ADDR,
  preference: 'fastest',
});

if (!quote) {
  console.log('❌ No quote returned');
  process.exit(1);
}
console.log(`Quote: ${quote.outputAmount} USDC, fee: $${quote.estimatedFeeUsd}`);

// Phase 1: buildTransaction (may include approval)
console.log('\nPhase 1: buildTransaction...');
const tx = await squid.buildTransaction(quote);
console.log(`needsPostApprovalBuild: ${tx.needsPostApprovalBuild ?? false}`);
console.log(`Has approvalTx: ${!!tx.approvalTx}`);

if (tx.approvalTx) {
  // Check allowance first
  const router = tx.to;
  const allowance = await erc20.allowance(WALLET_ADDR, router);
  console.log(`Current allowance for ${router}: ${allowance}`);

  if (allowance < BigInt(amount)) {
    console.log('Sending approval tx...');
    const approveTx = await wallet.sendTransaction({
      to: tx.approvalTx.to,
      data: tx.approvalTx.data,
      value: tx.approvalTx.value,
    });
    console.log(`Approval tx: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Approval confirmed ✅');
  } else {
    console.log('Already approved ✅');
  }

  if (tx.needsPostApprovalBuild) {
    // Phase 2: re-fetch bridge tx with fresh nonce
    console.log('\nPhase 2: buildBridgeTransaction (fresh nonce)...');
    const bridgeTx = await squid.buildBridgeTransaction(quote);
    console.log('Sending bridge tx...');
    const txResponse = await wallet.sendTransaction({
      to: bridgeTx.to,
      data: bridgeTx.data,
      value: bridgeTx.value,
    });
    console.log(`✅ Bridge tx: ${txResponse.hash}`);
    await txResponse.wait();
    console.log('Bridge tx confirmed!');
  } else {
    // Send bridge tx from original response
    console.log('Sending bridge tx...');
    const txResponse = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    console.log(`✅ Bridge tx: ${txResponse.hash}`);
    await txResponse.wait();
    console.log('Bridge tx confirmed!');
  }
} else {
  console.log('No approval needed, sending bridge tx directly...');
  const txResponse = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  console.log(`✅ Bridge tx: ${txResponse.hash}`);
  await txResponse.wait();
  console.log('Bridge tx confirmed!');
}

console.log('\nWaiting 30s for bridge completion...');
await new Promise(r => setTimeout(r, 30000));

const opProvider = new ethers.JsonRpcProvider('https://mainnet.optimism.io');
const opErc20 = new ethers.Contract(opUSDC, ['function balanceOf(address) view returns (uint256)'], opProvider);
const afterBal = await opErc20.balanceOf(WALLET_ADDR);
console.log(`OP USDC balance: ${ethers.formatUnits(afterBal, 6)}`);
console.log('\n=== Test Complete ===');
