# BridgeKitty 🐱

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
git clone <repo-url> && cd bridgekitty
npm install
npm run build
```

## Usage

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "node",
      "args": ["/absolute/path/to/bridgekitty/dist/index.js"]
    }
  }
}
```

### Claude Code / OpenClaw

Add to your MCP server config:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "node",
      "args": ["/absolute/path/to/bridgekitty/dist/index.js"]
    }
  }
}
```

### Direct (stdio)

```bash
node dist/index.js
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LIFI_API_KEY` | No | — | LI.FI API key for higher rate limits (free tier: 75 req/s) |
| `LIFI_INTEGRATOR` | No | — | LI.FI integrator ID (register at https://portal.li.fi/) |
| `LIFI_FEE` | No | `0.001` | Integrator fee as decimal (0.001 = 0.1%). Requires registered integrator. |
| `DEBRIDGE_AFFILIATE_FEE` | No | `0.1` | deBridge affiliate fee as percent (0.1 = 0.1%) |
| `DEBRIDGE_AFFILIATE_ADDRESS` | No | — | Address to receive deBridge affiliate fees (origin chain) |
| `ACROSS_REFERRAL_ADDRESS` | No | — | Referrer address for Across LP fee sharing |
| `RELAY_REFERRER_ADDRESS` | No | — | Address to receive Relay app fees |
| `RELAY_APP_FEE` | No | `10` | Relay app fee in basis points (10 = 0.1%) |

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
BridgeKitty Server
    |
    +-- Tool Layer (5 tools)
    |       |
    +-- Routing Engine (parallel queries, ranking, caching)
    |       |
    +-- Backend Adapters
            +-- LI.FI (59+ chains)
            +-- deBridge DLN
            +-- Across Protocol
            +-- Relay
            +-- Persistence Interop (BTC swaps)
```

## Revenue Model

BridgeKitty earns integrator/referral fees on routes through third-party backends. Default fee: 0.1% (10 bips) where configurable. No fees on Persistence Interop (our own solver).

| Backend | Fee Type | How to Enable |
|---------|----------|---------------|
| **LI.FI** | Integrator fee | Set `LIFI_INTEGRATOR` + `LIFI_FEE` (register at https://portal.li.fi/) |
| **deBridge** | Affiliate fee | Set `DEBRIDGE_AFFILIATE_ADDRESS` (fee % defaults to 0.1%) |
| **Across** | Referral fee sharing | Set `ACROSS_REFERRAL_ADDRESS` |
| **Relay** | App fee | Set `RELAY_REFERRER_ADDRESS` (fee bps defaults to 10) |
| **Persistence** | — | No fees (we're the solver) |

## License

MIT
