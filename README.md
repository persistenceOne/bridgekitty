# MCP Bridge Aggregator

Cross-chain bridge aggregation for AI agents. One MCP server, all bridges, best routes.

Queries multiple bridge protocols in parallel (LI.FI covering 59+ chains and 27+ bridges, plus Persistence Interop for BTC cross-chain swaps), ranks results by cost or speed, and returns unsigned transactions for the agent to sign.

## Tools

| Tool | Description |
|------|-------------|
| `bridge_get_quote` | Get best bridge quote across all providers |
| `bridge_execute` | Get unsigned transaction data to execute a bridge transfer |
| `bridge_status` | Check status of a bridge transfer |
| `bridge_chains` | List all supported chains |
| `bridge_tokens` | List tokens available on a chain |

## Install

```bash
git clone <repo-url> && cd mcp-bridge-aggregator
npm install
npm run build
```

## Usage

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "bridge-aggregator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-bridge-aggregator/dist/index.js"]
    }
  }
}
```

### Claude Code / OpenClaw

Add to your MCP server config:

```json
{
  "mcpServers": {
    "bridge-aggregator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-bridge-aggregator/dist/index.js"]
    }
  }
}
```

### Direct (stdio)

```bash
node dist/index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LIFI_API_KEY` | No | LI.FI API key for higher rate limits (free tier: 75 req/s) |
| `LIFI_INTEGRATOR` | No | LI.FI integrator ID (register at https://portal.li.fi/) |
| `LIFI_FEE` | No | Integrator fee as decimal (e.g. `0.003` for 0.3%). Requires registered integrator. |

## Example Flow

An agent bridging 100 USDC from Ethereum to Base:

```
1. bridge_get_quote(fromChain: "ethereum", toChain: "base", fromToken: "USDC",
                     toToken: "USDC", amount: "100", fromAddress: "0x...")
   -> Returns best quote with quoteId

2. bridge_execute(quoteId: "<from step 1>")
   -> Returns unsigned transaction(s) -- approval tx + bridge tx

3. Agent signs and sends the transaction(s)

4. bridge_status(txHash: "<from step 3>", fromChain: "1", toChain: "8453")
   -> Returns transfer status
```

## Supported Backends

### LI.FI (59+ chains, 27+ bridges)

Aggregates across Stargate, Across, Hop, Celer, Connext, Synapse, and many more. Covers most EVM chains including Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Linea, Scroll, zkSync, Mantle, Blast, and others.

### Persistence Interop

Intent-based BTC cross-chain swaps between Base (cbBTC) and BNB Chain (BTCB) via the Persistence solver network.

## Architecture

```
MCP Client (Agent)
    |
    | MCP Protocol (stdio)
    v
MCP Bridge Aggregator Server
    |
    +-- Tool Layer (5 tools)
    |       |
    +-- Routing Engine (parallel queries, ranking, caching)
    |       |
    +-- Backend Adapters
            +-- LI.FI (59+ chains)
            +-- Persistence Interop (BTC swaps)
```

## Revenue Model

When `LIFI_INTEGRATOR` and `LIFI_FEE` are configured with a registered integrator, a fee is applied to LI.FI routes automatically. Register at https://portal.li.fi/ to set up fee collection.

## License

MIT
