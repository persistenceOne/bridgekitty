---
name: bridgekitty
description: Cross-chain bridge aggregator MCP server for AI agents. Compares routes across LI.FI, deBridge, Relay, Across and Squid to find the best rate. Use when an agent needs to bridge or swap tokens between EVM chains, Solana, or Cosmos. The aggregator of aggregators.
---

# BridgeKitty 🐱

Cross-chain bridge aggregator that finds the best route across 5 bridge backends.

## Setup

Add to your MCP config:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "npx",
      "args": ["@persistenceone/bridgekitty"]
    }
  }
}
```

No API keys required for basic usage. Optional: set `LIFI_API_KEY` for enhanced rate limits.

## Available Tools

### bridge_chains
List all supported chains (119+ EVM, Solana, Cosmos).

### bridge_tokens
Search for tokens on a specific chain by name or symbol.

### bridge_get_quote
Get the best bridge route. Queries all backends in parallel, ranks by net value received.

**Required params:** `fromChain`, `toChain`, `fromToken`, `toToken`, `amount`
**Optional:** `senderAddress`, `recipientAddress`

### bridge_multi_quote
Compare quotes across all backends side-by-side. Returns all available routes with fee breakdowns.

### bridge_execute
Execute a bridge transaction. Returns unsigned transaction data (or signs and sends if `sign_and_send: true` with a configured wallet).

### bridge_status
Check the status of an in-progress bridge transfer.

### wallet_setup
Create or import EVM/Cosmos/Solana wallets for the agent.

### wallet_balance
Check token balances across chains.

### bridge_help
Get contextual help about any BridgeKitty feature.

## Typical Workflow

1. `bridge_chains` — find chain IDs
2. `bridge_tokens` — find token addresses
3. `bridge_get_quote` — get best route with fees
4. `bridge_execute` — execute the transfer
5. `bridge_status` — monitor completion

## Supported Directions

| Direction | Backends |
|-----------|----------|
| EVM → EVM | All 5 backends |
| EVM → Solana | deBridge, Relay |
| Solana → EVM | deBridge |
| EVM → Cosmos | Squid |

## Notes

- All transactions are returned **unsigned** by default — the agent or user signs separately
- Quotes expire after 60 seconds and auto-refresh on execute
- Gas estimation included in all quotes
- Circuit breaker protection: failing backends are temporarily disabled
