const { ethers } = require('ethers');

const PRIVATE_KEY = '0x58cc6cac41dbf169bc84374709e6977c4ace356153ad48258b9039dd634799e3';
const WALLET_ADDR = '0x221726819bcfDDC3B05be56369a14ac836E64B7F';
const AMRITH_WALLET = '0xBea88A02343bCC5F1937851433E85FE5B5F12A3C';

const USDC_OPTIMISM = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const OPT_RPC = 'https://mainnet.optimism.io';
const BASE_RPC = 'https://mainnet.base.org';

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

async function step1_bridgeOptimismToBase() {
  console.log('=== Step 1: Bridge USDC Optimism → Base via Relay ===\n');

  const optProvider = new ethers.JsonRpcProvider(OPT_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, optProvider);

  // Check balance
  const usdc = new ethers.Contract(USDC_OPTIMISM, erc20Abi, wallet);
  const balance = await usdc.balanceOf(WALLET_ADDR);
  const decimals = await usdc.decimals();
  console.log(`USDC on Optimism: ${ethers.formatUnits(balance, decimals)}`);

  if (balance === 0n) {
    console.log('No USDC on Optimism, skipping bridge.');
    return;
  }

  // Get Relay quote
  const quoteBody = {
    user: WALLET_ADDR,
    originChainId: 10,
    destinationChainId: 8453,
    originCurrency: USDC_OPTIMISM,
    destinationCurrency: USDC_BASE,
    amount: balance.toString(),
    recipient: WALLET_ADDR,
    tradeType: 'EXACT_INPUT',
  };

  console.log('Fetching Relay quote...');
  const quoteRes = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quoteBody),
  });

  if (!quoteRes.ok) {
    const err = await quoteRes.text();
    console.error('Relay quote failed:', err);
    return;
  }

  const quote = await quoteRes.json();
  console.log('Quote received. Steps:', quote.steps?.length);

  // Execute each step
  for (const step of quote.steps) {
    for (const item of step.items) {
      const txData = item.data;
      console.log(`\nSending tx: ${step.id} to ${txData.to}`);

      // Check if it's an approval
      if (step.id === 'approve') {
        const tx = await wallet.sendTransaction({
          to: txData.to,
          data: txData.data,
          value: txData.value ? BigInt(txData.value) : 0n,
          chainId: 10,
        });
        console.log('Approval tx:', tx.hash);
        await tx.wait();
        console.log('Approval confirmed.');
        continue;
      }

      // Main bridge tx
      const tx = await wallet.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? BigInt(txData.value) : 0n,
        chainId: 10,
      });
      console.log('Bridge tx:', tx.hash);
      const receipt = await tx.wait();
      console.log('Bridge tx confirmed! Block:', receipt.blockNumber);
    }
  }

  // Wait for bridge to complete (poll Base USDC balance)
  console.log('\nWaiting for USDC to arrive on Base...');
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const baseUsdc = new ethers.Contract(USDC_BASE, erc20Abi, baseProvider);
  const startBalance = await baseUsdc.balanceOf(WALLET_ADDR);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const newBal = await baseUsdc.balanceOf(WALLET_ADDR);
    if (newBal > startBalance) {
      console.log(`\n✅ Bridge complete! Base USDC: ${ethers.formatUnits(newBal, 6)}`);
      return newBal;
    }
    process.stdout.write('.');
  }
  console.log('\n⚠️ Timeout waiting for bridge. Check manually.');
}

async function step2_sendTestToAmrith() {
  console.log('\n=== Step 2: Send $1 USDC to Amrith on Base ===\n');

  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, baseProvider);
  const usdc = new ethers.Contract(USDC_BASE, erc20Abi, wallet);

  const balance = await usdc.balanceOf(WALLET_ADDR);
  console.log(`Base USDC balance: ${ethers.formatUnits(balance, 6)}`);

  const oneUSDC = ethers.parseUnits('1', 6); // 1 USDC
  if (balance < oneUSDC) {
    console.error('Not enough USDC on Base for $1 test send!');
    return;
  }

  console.log(`Sending 1 USDC to ${AMRITH_WALLET}...`);
  const tx = await usdc.transfer(AMRITH_WALLET, oneUSDC);
  console.log('Tx hash:', tx.hash);
  const receipt = await tx.wait();
  console.log(`✅ Test transfer confirmed! Block: ${receipt.blockNumber}`);
  console.log(`Basescan: https://basescan.org/tx/${tx.hash}`);

  const remaining = await usdc.balanceOf(WALLET_ADDR);
  console.log(`Remaining USDC on Base: ${ethers.formatUnits(remaining, 6)}`);
}

async function main() {
  const action = process.argv[2] || 'bridge';

  if (action === 'bridge') {
    await step1_bridgeOptimismToBase();
  } else if (action === 'send-test') {
    await step2_sendTestToAmrith();
  } else if (action === 'both') {
    await step1_bridgeOptimismToBase();
    await step2_sendTestToAmrith();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
