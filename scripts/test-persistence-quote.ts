import { PersistenceBackend } from "../src/backends/persistence.js";

const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
const CBBTC_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";

async function main() {
  const backend = new PersistenceBackend();
  
  console.log("1. Testing cbBTC (Base) → BTCB (BSC) quote...");
  const quote = await backend.getQuote({
    fromChainId: 8453, toChainId: 56,
    fromTokenAddress: CBBTC_BASE, toTokenAddress: BTCB_BSC,
    amountRaw: "14597", // our full cbBTC balance
    fromAddress: WALLET, toAddress: WALLET,
    preference: "fastest",
  });
  
  if (!quote) {
    console.log("❌ No quote returned (solver may be offline or amount below cap)");
    return;
  }
  
  console.log(`✅ Quote received!`);
  console.log(`  Provider: ${quote.provider}`);
  console.log(`  Input: 0.00014597 cbBTC on Base`);
  console.log(`  Output: ${quote.minOutputAmount} BTCB on BSC`);
  console.log(`  Gas: ~$${quote.estimatedGasCostUsd}`);
  console.log(`  ETA: ${quote.estimatedTimeSeconds}s`);
  console.log(`  Expires: ${new Date(quote.expiresAt).toISOString()}`);

  // Try buildTransaction — should throw explaining EIP-712 requirement
  console.log("\n2. Testing buildTransaction (should explain EIP-712 requirement)...");
  try {
    await backend.buildTransaction(quote);
    console.log("⚠️ Unexpected success — buildTransaction should throw for Persistence");
  } catch (e: any) {
    console.log(`✅ Correctly throws: ${e.message.slice(0, 200)}`);
  }

  // Test status endpoint with a dummy order
  console.log("\n3. Testing status endpoint...");
  try {
    const status = await backend.getStatus("persistence:test-order-123", {});
    console.log(`Status: ${status.state} — ${status.humanReadable}`);
  } catch (e: any) {
    console.log(`Status check: ${e.message.slice(0, 100)}`);
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
