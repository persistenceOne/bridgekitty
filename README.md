# MCP Bridge Aggregator

Cross-chain bridge aggregation for AI agents. One MCP server, all bridges, best routes.

## What it does

- Queries multiple bridge protocols in parallel (LI.FI, Persistence Interop)
- Returns the best route by cost or speed
- Provides unsigned transactions for the agent to sign
- Tracks bridge transfer status

## Tools

| Tool | Description |
|------|-------------|
| `bridge_get_quote` | Get best bridge quote across all providers |
| `bridge_execute` | Get transaction data to execute a bridge transfer |
| `bridge_status` | Check status of a bridge transfer |
| `bridge_chains` | List all supported chains |
| `bridge_tokens` | List tokens available on a chain |

## Quick Start

```bash
npm install
npm run build
```

### Use with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridge-aggregator": {
      "command": "node",
      "args": ["/path/to/mcp-bridge-aggregator/dist/index.js"]
    }
  }
}
```

### Use with OpenClaw

```json
{
  "mcpServers": {
    "bridge-aggregator": {
      "command": "node",
      "args": ["/path/to/mcp-bridge-aggregator/dist/index.js"]
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LIFI_API_KEY` | No | LI.FI API key for higher rate limits |

## Supported Bridges

### Via LI.FI (35+ chains, 27+ bridges)
Stargate, Hop, Across, Celer, Connext, Multichain, Synapse, and many more.

### Via Persistence Interop
Intent-based BTC cross-chain swaps on Base and BSC (cbBTC ↔ BTCB).

## Example Usage

An agent can bridge 100 USDC from Ethereum to Base:

```
1. bridge_get_quote(fromChain: "ethereum", toChain: "base", fromToken: "USDC", toToken: "USDC", amount: "100", fromAddress: "0x...")
2. bridge_execute(quoteId: "<from step 1>")
3. Sign and send the returned transaction
4. bridge_status(trackingId: "<from step 2>")
```

## Revenue Model

0.3% integrator fee on LI.FI routes, captured automatically via the `integrator` and `fee` parameters.

## License

MIT
