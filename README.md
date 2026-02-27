# BridgeKitty 🐱

Cross-chain bridge aggregator for AI agents. One MCP server, all bridges, best routes.

BridgeKitty gives AI agents (Claude, GPT, etc.) the ability to find and execute cross-chain bridge transfers across multiple protocols — with automatic route optimization, fee comparison, and safety checks.

## Supported Bridges

| Backend | Type | Strength |
|---------|------|----------|
| **LI.FI** | Aggregator | Widest coverage (30+ bridges, any-to-any swap) |
| **deBridge (DLN)** | Direct | Fast intent-based fills, low fees |
| **Across** | Direct | Fastest fills (~6s), same-token bridging |
| **Relay** | Direct | Simple UX, competitive gas-optimized routes |
| **Persistence** | Custom | Persistence One interop routes |

## Quick Start

### npx (zero install)

```bash
npx bridgekitty
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "npx",
      "args": ["bridgekitty"],
      "env": {}
    }
  }
}
```

### OpenClaw / mcporter

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "npx",
      "args": ["bridgekitty"],
      "env": {
        "LIFI_API_KEY": "optional-key",
        "LIFI_INTEGRATOR": "your-app-name"
      }
    }
  }
}
```

### Local Development

```bash
git clone <repo-url>
cd bridgekitty
npm install
npm run build
npm start
```

## Environment Variables

All optional — BridgeKitty works with zero configuration.

| Variable | Description |
|----------|-------------|
| `LIFI_API_KEY` | LI.FI API key (higher rate limits) |
| `LIFI_INTEGRATOR` | LI.FI integrator name |
| `LIFI_FEE` | LI.FI integrator fee (e.g. `"0.003"` = 0.3%) |
| `DEBRIDGE_AFFILIATE_FEE` | deBridge affiliate fee % |
| `DEBRIDGE_AFFILIATE_ADDRESS` | deBridge affiliate address |
| `RELAY_REFERRER_ADDRESS` | Relay referrer address |
| `RELAY_APP_FEE` | Relay app fee |
| `ACROSS_REFERRAL_ADDRESS` | Across referrer address |
| `BRIDGEKITTY_TX_TIMEOUT_MS` | Transaction build timeout (default: 30000) |

## MCP Tools

### `bridge_get_quote`

Get competitive bridge quotes across all backends.

**Input:**
```json
{
  "fromChain": "ethereum",
  "toChain": "arbitrum",
  "fromToken": "USDC",
  "toToken": "USDC",
  "amount": "100",
  "fromAddress": "0xYourAddress...",
  "preference": "cheapest"
}
```

**Output:** Ranked list of quotes with fees, estimated time, and a `quoteId` for execution.

### `bridge_execute`

Build unsigned transaction(s) from a quote.

**Input:**
```json
{
  "quoteId": "uuid-from-get-quote"
}
```

**Output:** Unsigned transaction data (to, data, value, chainId) + optional approval tx. The agent signs and sends via its wallet.

### `bridge_status`

Check the status of a bridge transfer.

**Input:**
```json
{
  "trackingId": "provider:tracking-id",
  "txHash": "0x..."
}
```

### `bridge_chains`

List all supported chains.

### `bridge_tokens`

Search for tokens on a specific chain.

**Input:**
```json
{
  "chain": "ethereum",
  "search": "USDC"
}
```

## Architecture

```
Agent → MCP Tools → Routing Engine → [LI.FI, deBridge, Across, Relay, ...]
                         ↓
                   Quote Cache + Circuit Breaker
                         ↓
                   Best Quote → buildTransaction → Unsigned TX
```

- **Routing Engine:** Fans out to all backends, sorts by cost/speed, caches quotes
- **Circuit Breaker:** Automatically skips failing backends, gradual recovery
- **Token Registry:** 45+ verified tokens with canonical addresses per chain
- **Transaction Simulator:** Dry-runs transactions before returning to agent

## Security

- Token-only approval (exact amounts, never unlimited)
- Transaction simulation before execution
- Verified token registry prevents sending to wrong contracts
- No private keys — agents sign transactions externally
- Circuit breaker prevents cascading failures

## License

MIT
