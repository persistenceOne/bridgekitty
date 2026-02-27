import { readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';

// Load .env
const envContent = readFileSync('.env', 'utf8');
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

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WALLET_ADDR = '0x221726819bcfDDC3B05be56369a14ac836E64B7F';

const RPC = {
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
  56: 'https://bsc-dataseed1.binance.org',
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

function provider(chainId) { return new ethers.JsonRpcProvider(RPC[chainId]); }
function wallet(chainId) { return new ethers.Wallet(PRIVATE_KEY, provider(chainId)); }

async function getBalance(chainId, tokenAddr) {
  if (tokenAddr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return await provider(chainId).getBalance(WALLET_ADDR);
  }
  const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider(chainId));
  return await c.balanceOf(WALLET_ADDR);
}

const results = [];
function log(msg) { console.log(msg); results.push(msg); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== TEST 1: SQUID — Base USDC → OP USDC ==========
async function testSquid() {
  log('\n========== TEST 1: SQUID — Base USDC → OP USDC ==========');
  try {
    const { SquidBackend } = await import('./dist/backends/squid.js');
    const squid = new SquidBackend();

    const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const opUSDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';

    const beforeBal = await getBalance(10, opUSDC);
    log(`Before OP USDC balance: ${ethers.formatUnits(beforeBal, 6)}`);

    log('Getting quote...');
    const quote = await squid.getQuote({
      fromChainId: 8453, toChainId: 10,
      fromTokenAddress: baseUSDC, toTokenAddress: opUSDC,
      amountRaw: '500000', fromAddress: WALLET_ADDR,
      preference: 'cheapest',
    });
    if (!quote) { log('❌ Squid: No quote returned'); return; }
    log(`Quote: ${quote.estimatedOutputRaw} raw out, fee: $${quote.fees?.totalFeeUsd ?? '?'}`);

    log('Building tx...');
    const txReq = await squid.buildTransaction(quote);
    log(`Tx to: ${txReq.to}, chainId: ${txReq.chainId}`);

    const w = wallet(8453);

    // Handle approval
    if (txReq.approvalTx) {
      const erc20 = new ethers.Contract(baseUSDC, ERC20_ABI, w);
      const spender = txReq.approvalTx.to === baseUSDC
        ? ethers.getAddress(ethers.dataSlice(txReq.approvalTx.data, 16, 36))
        : txReq.approvalTx.to;
      // Actually, approvalTx.to is the token, data encodes approve(spender, amount)
      // Let's just send the approval tx as-is
      const currentAllowance = await erc20.allowance(WALLET_ADDR, txReq.to);
      log(`Current allowance for router: ${currentAllowance}`);
      if (currentAllowance < 500000n) {
        log('Sending approval tx...');
        const approveTx = await w.sendTransaction({
          to: txReq.approvalTx.to,
          data: txReq.approvalTx.data,
          value: txReq.approvalTx.value,
          gasLimit: 100000,
        });
        log(`Approval tx: ${approveTx.hash}`);
        await approveTx.wait();
        log('Approved.');
      } else {
        log('Already approved.');
      }
    }

    // Send bridge tx
    log('Sending bridge tx...');
    const tx = await w.sendTransaction({
      to: txReq.to,
      data: txReq.data,
      value: txReq.value,
      gasLimit: 500000,
    });
    log(`✅ Squid tx hash: ${tx.hash}`);
    await tx.wait();
    log('Confirmed on Base.');

    log('Waiting 45s for bridge...');
    await sleep(45000);

    const afterBal = await getBalance(10, opUSDC);
    log(`After OP USDC balance: ${ethers.formatUnits(afterBal, 6)}`);
    log(`Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
  } catch (err) {
    log(`❌ Squid error: ${err.message}\n${err.stack}`);
  }
}

// ========== TEST 2: ACROSS — Base ETH → Arb ETH ==========
async function testAcross() {
  log('\n========== TEST 2: ACROSS — Base ETH → Arb ETH ==========');
  try {
    const { AcrossBackend } = await import('./dist/backends/across.js');
    const across = new AcrossBackend(process.env.ACROSS_REFERRAL_ADDRESS);

    const ethAddr = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const amountRaw = '500000000000000'; // 0.0005 ETH

    const beforeBal = await provider(42161).getBalance(WALLET_ADDR);
    log(`Before Arb ETH balance: ${ethers.formatEther(beforeBal)}`);

    log('Getting quote...');
    const quote = await across.getQuote({
      fromChainId: 8453, toChainId: 42161,
      fromTokenAddress: ethAddr, toTokenAddress: ethAddr,
      amountRaw, fromAddress: WALLET_ADDR,
      preference: 'cheapest',
    });
    if (!quote) { log('❌ Across: No quote returned'); return; }
    log(`Quote: ${quote.estimatedOutputRaw} raw out, fee: $${quote.fees?.totalFeeUsd ?? '?'}`);

    log('Building tx...');
    const txReq = await across.buildTransaction(quote);
    log(`Tx to: ${txReq.to}, chainId: ${txReq.chainId}, value: ${txReq.value}`);

    const w = wallet(8453);
    log('Sending bridge tx...');
    const tx = await w.sendTransaction({
      to: txReq.to,
      data: txReq.data,
      value: amountRaw, // native ETH deposit
      gasLimit: 500000,
    });
    log(`✅ Across tx hash: ${tx.hash}`);
    await tx.wait();
    log('Confirmed on Base.');

    log('Waiting 30s for bridge...');
    await sleep(30000);

    const afterBal = await provider(42161).getBalance(WALLET_ADDR);
    log(`After Arb ETH balance: ${ethers.formatEther(afterBal)}`);
    log(`Received: ${ethers.formatEther(afterBal - beforeBal)} ETH`);
  } catch (err) {
    log(`❌ Across error: ${err.message}\n${err.stack}`);
  }
}

// ========== TEST 3: DEBRIDGE — Arb USDC → Base USDC ==========
async function testDeBridge() {
  log('\n========== TEST 3: DEBRIDGE — Arb USDC → Base USDC ==========');
  try {
    const { DeBridgeBackend } = await import('./dist/backends/debridge.js');
    const debridge = new DeBridgeBackend('0.3', '0xb24aCFcda187135490d81517ab56709FdDe6a81A');

    const arbUSDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    const beforeBal = await getBalance(8453, baseUSDC);
    log(`Before Base USDC balance: ${ethers.formatUnits(beforeBal, 6)}`);

    log('Getting quote...');
    const quote = await debridge.getQuote({
      fromChainId: 42161, toChainId: 8453,
      fromTokenAddress: arbUSDC, toTokenAddress: baseUSDC,
      amountRaw: '500000', fromAddress: WALLET_ADDR,
      preference: 'cheapest',
    });
    if (!quote) { log('❌ deBridge: No quote returned'); return; }
    log(`Quote: ${quote.estimatedOutputRaw} raw out, fee: $${quote.fees?.totalFeeUsd ?? '?'}`);

    log('Building tx...');
    const txReq = await debridge.buildTransaction(quote);
    log(`Tx to: ${txReq.to}, chainId: ${txReq.chainId}, value: ${txReq.value}`);

    const w = wallet(42161);

    // Handle approval
    if (txReq.approvalTx) {
      log('Sending approval tx...');
      const approveTx = await w.sendTransaction({
        to: txReq.approvalTx.to,
        data: txReq.approvalTx.data,
        value: txReq.approvalTx.value || '0x0',
        gasLimit: 100000,
      });
      log(`Approval tx: ${approveTx.hash}`);
      await approveTx.wait();
      log('Approved.');
    }

    // Send bridge tx — include value for protocol fee
    log('Sending bridge tx...');
    const tx = await w.sendTransaction({
      to: txReq.to,
      data: txReq.data,
      value: txReq.value,
      gasLimit: 500000,
    });
    log(`✅ deBridge tx hash: ${tx.hash}`);
    await tx.wait();
    log('Confirmed on Arb.');

    log('Waiting 45s for bridge...');
    await sleep(45000);

    const afterBal = await getBalance(8453, baseUSDC);
    log(`After Base USDC balance: ${ethers.formatUnits(afterBal, 6)}`);
    log(`Received: ${ethers.formatUnits(afterBal - beforeBal, 6)} USDC`);
  } catch (err) {
    log(`❌ deBridge error: ${err.message}\n${err.stack}`);
  }
}

// ========== TEST 4: PERSISTENCE — BSC BTCB → Base cbBTC ==========
async function testPersistence() {
  log('\n========== TEST 4: PERSISTENCE — BSC BTCB → Base cbBTC ==========');
  try {
    const { PersistenceBackend } = await import('./dist/backends/persistence.js');
    const persistence = new PersistenceBackend();

    const btcb = '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c';
    const cbbtc = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
    const amountRaw = '50000000000000'; // 0.00005 BTCB (18 dec)

    const beforeBal = await getBalance(8453, cbbtc);
    log(`Before Base cbBTC balance: ${ethers.formatUnits(beforeBal, 8)}`);

    log('Getting quote...');
    const quote = await persistence.getQuote({
      fromChainId: 56, toChainId: 8453,
      fromTokenAddress: btcb, toTokenAddress: cbbtc,
      amountRaw, fromAddress: WALLET_ADDR,
      preference: 'cheapest',
    });
    if (!quote) { log('❌ Persistence: No quote returned'); return; }
    log(`Quote: ${quote.estimatedOutputRaw} raw out, fee: $${quote.fees?.totalFeeUsd ?? '?'}`);

    log('Calling signAndExecute...');
    const w = wallet(56);
    const result = await persistence.signAndExecute(quote, w);
    log(`✅ Persistence tx hash: ${result.txHash}`);
    log(`Order ID: ${result.orderId}`);

    log('Waiting 60s for bridge...');
    await sleep(60000);

    const afterBal = await getBalance(8453, cbbtc);
    log(`After Base cbBTC balance: ${ethers.formatUnits(afterBal, 8)}`);
    log(`Received: ${ethers.formatUnits(afterBal - beforeBal, 8)} cbBTC`);
  } catch (err) {
    log(`❌ Persistence error: ${err.message}\n${err.stack}`);
  }
}

// ========== RUN ALL ==========
async function main() {
  log('# E2E Test Round 3 — ' + new Date().toISOString());
  log(`Wallet: ${WALLET_ADDR}`);

  await testSquid();
  await testAcross();
  await testDeBridge();
  await testPersistence();

  log('\n========== DONE ==========');
  writeFileSync('test-e2e-results-round3.md', results.join('\n'));
  console.log('\nResults saved to test-e2e-results-round3.md');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
