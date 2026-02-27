# BridgeKitty 🐱

Cross-chain bridge aggregator MCP server for AI agents. One server, 6 bridge backends, best routes across 100+ chains.

BridgeKitty gives AI agents (Claude, Cursor, GPT, or any MCP-compatible AI) the ability to find and execute cross-chain bridge transfers — with automatic route optimization, fee comparison, and safety checks.

## Supported Bridges

| Backend | Type | Strength |
|---------|------|----------|
| **LI.FI** | Aggregator | Widest coverage (30+ bridges, any-to-any swap) |
| **Skip** | Aggregator | 120+ chains including 62+ Cosmos/IBC chains |
| **deBridge (DLN)** | Direct | Fast intent-based fills, low fees |
| **Across** | Direct | Fastest fills (~6s), same-token bridging |
| **Relay** | Direct | Gas-optimized, competitive routes |
| **Persistence Interop** | Custom | BTC bridging (cbBTC/BTCB) + XPRT farming rewards |

## Quick Start

### npx (zero install)

```bash
npx bridgekitty
```

### Claude Code

Tell your agent:

> Enable bridgekitty for swapping or bridging crypto across chains

Or add to your MCP config (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "npx",
      "args": ["bridgekitty"]
    }
  }
}
```

### Cursor IDE

Add to Cursor's MCP settings (Settings > MCP Servers):

```json
{
  "bridgekitty": {
    "command": "npx",
    "args": ["bridgekitty"]
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridgekitty": {
      "command": "npx",
      "args": ["bridgekitty"]
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
| `SKIP_API_KEY` | Skip Protocol API key (higher rate limits) |

## MCP Tools

### Core Bridge Tools

#### `bridge_get_quote`

Get competitive bridge quotes across all backends.

```json
{
  "fromChain": "base",
  "toChain": "arbitrum",
  "fromToken": "USDC",
  "toToken": "USDC",
  "amount": "100",
  "fromAddress": "0xYourAddress..."
}
```

Returns ranked list of quotes with fees, estimated time, and a `quoteId` for execution.

#### `bridge_execute`

Build unsigned transaction(s) from a quote.

```json
{ "quoteId": "uuid-from-get-quote" }
```

Returns unsigned transaction data (to, data, value, chainId) + optional approval tx. The agent signs and sends via its wallet.

#### `bridge_status`

Check the status of a bridge transfer.

```json
{ "trackingId": "provider:tracking-id", "txHash": "0x..." }
```

#### `bridge_chains`

List all supported chains with provider coverage.

#### `bridge_tokens`

Search for tokens on a specific chain.

```json
{ "chain": "base", "search": "USDC" }
```

### Wallet Tools

#### `wallet_setup`

Create wallets for all supported chains (EVM, Cosmos, Solana). Derives from a single mnemonic. Credentials saved to `.env` in the working directory.

#### `wallet_balance`

Check wallet balances across chains.

### XPRT Farming Tools

Earn XPRT token rewards by bridging BTC variants (cbBTC on Base ↔ BTCB on BSC) through Persistence Interop.

#### `xprt_farm_prepare`

Convert ETH to cbBTC and bridge gas to BSC — sets up your wallet for farming.

#### `xprt_farm_start`

Start automated BTC round-trip swaps between Base and BSC. Configurable rounds, amounts, and risk limits.

#### `xprt_farm_status`

Check farming rewards status, wallet link, and current epoch info.

#### `xprt_farm_boost`

Buy and stake XPRT for reward multiplier boost (1x → 2x or 5x).

## Architecture

```
Agent → MCP Tools → Routing Engine → [LI.FI, Skip, deBridge, Across, Relay, Persistence]
                         ↓
                   Quote Cache + Circuit Breaker
                         ↓
                   Best Quote → buildTransaction → Unsigned TX
```

- **Routing Engine:** Parallel quotes from all backends, ranked by cost/speed
- **Circuit Breaker:** Auto-skips failing backends, gradual recovery
- **Token Registry:** 45+ verified tokens with canonical addresses per chain
- **Transaction Simulator:** Dry-runs transactions before returning to agent
- **Gas Estimator:** Chain-aware gas cost estimation with RPC failover

## Security

- Exact-amount approvals only (never unlimited)
- Transaction simulation before execution
- Verified token registry prevents phishing via malicious contracts
- No private keys in MCP flow — agents sign transactions externally
- Circuit breaker prevents cascading failures
- Error messages sanitized (no key/path leakage)
- `.env` file overwrite protection + permission checks

## License

MIT
