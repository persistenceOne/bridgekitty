# BridgeKitty — Local Setup Guide 🐱

## What you need first

- A Mac (or Linux) with a terminal app
- Node.js installed (check: open Terminal, type `node --version` — should show v18 or higher)

If you don't have Node.js: go to https://nodejs.org and download the LTS version.

---

## Step 1: Get the code

Open Terminal and run:

```bash
cd ~/Desktop
cp -r /Users/persistence/projects/bridgekitty bridgekitty-test
cd bridgekitty-test
```

## Step 2: Install & build

```bash
npm install
npm run build
```

Wait until it finishes. No errors = you're good.

## Step 3: Test it works

Run this to get a quote for bridging 1 USDC from Base → Arbitrum:

```bash
node -e '
import("./dist/backends/lifi.js").then(async ({LiFiBackend}) => {
  const b = new LiFiBackend();
  const q = await b.getQuote({
    fromChainId: 8453, toChainId: 42161,
    fromTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    toTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    amountRaw: "1000000",
    fromAddress: "0x0000000000000000000000000000000000000001",
    preference: "cheapest"
  });
  console.log(q ? "✅ Working! Quote: " + q.outputAmount + " USDC" : "❌ No quote");
})
'
```

You should see something like: `✅ Working! Quote: 0.99 USDC`

---

## Step 4: Connect to Claude Desktop

1. Open **Claude Desktop**
2. Go to **Settings → Developer → Edit Config**
3. It opens a JSON file. Replace the contents with:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "node",
      "args": ["/Users/YOURUSERNAME/Desktop/bridgekitty-test/dist/index.js"]
    }
  }
}
```

> Replace `YOURUSERNAME` with your actual Mac username (check with `whoami` in Terminal).

4. Save the file, **quit and reopen Claude Desktop**
5. You should see a 🔨 hammer icon at the bottom of the chat — that means BridgeKitty is connected

---

## Step 5: Talk to Claude

Try asking Claude:

- *"What chains do you support for bridging?"*
- *"Get me a quote to bridge 1 USDC from Base to Arbitrum"*
- *"Compare bridge quotes for 0.5 ETH from Ethereum to Optimism"*
- *"Set up a wallet for me"* (creates your wallets and saves keys to `.env`)
- *"What are the Persistence rewards?"*

---

## Available Tools (11)

| Tool | What it does |
|------|-------------|
| `bridge_get_quote` | Get quotes from all 6 backends, ranked by output |
| `bridge_execute` | Build transaction(s) to execute a quote |
| `bridge_status` | Track a bridge transfer |
| `bridge_chains` | List supported chains per backend |
| `bridge_tokens` | List tokens on a chain |
| `wallet_setup` | Generate EVM + Cosmos + Solana wallets |
| `wallet_balance` | Check balances across chains |
| `persistence_rewards_prepare` | Fund wallet for Persistence reward farming |
| `persistence_rewards_start` | Run cbBTC↔BTCB bridge rounds to earn XPRT |
| `persistence_rewards_status` | Check reward earnings & tier |
| `persistence_rewards_boost` | Buy XPRT to boost reward tier |

## Supported Bridges

| Backend | Chains | Strength |
|---------|--------|----------|
| **LI.FI** | 30+ | Widest coverage, any-to-any swap |
| **Squid** | 89 (incl. 62 Cosmos) | Best Cosmos coverage |
| **deBridge** | EVM + Solana | Fast intent-based fills |
| **Across** | Major EVM | Fastest fills (~6s) |
| **Relay** | Major EVM | Simple, gas-optimized |
| **Persistence** | Base ↔ BSC | BTCB↔cbBTC with XPRT rewards |

---

**That's it.** No API keys, no config files, no accounts to create. Quotes from 6 different bridge providers work immediately. 🐱
