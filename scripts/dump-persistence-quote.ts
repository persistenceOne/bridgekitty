import { PersistenceBackend } from "../src/backends/persistence.js";

const WALLET = "0x221726819bcfDDC3B05be56369a14ac836E64B7F";
async function main() {
  const b = new PersistenceBackend();
  const q = await b.getQuote({
    fromChainId: 8453, toChainId: 56,
    fromTokenAddress: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    toTokenAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    amountRaw: "14597", fromAddress: WALLET, toAddress: WALLET,
    preference: "cheapest",
  });
  if (!q) { console.log("no quote"); return; }
  console.log("=== Full quoteData ===");
  console.log(JSON.stringify(q.quoteData, null, 2));
}
main().catch(console.error);
