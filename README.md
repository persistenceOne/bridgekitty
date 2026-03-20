# BridgeKitty 🐱

Cross-chain bridge aggregator MCP server for AI agents. One server, 5 bridge backends, best routes across EVM, Solana, and Cosmos chains.

BridgeKitty gives AI agents (Claude, Cursor, GPT, or any MCP-compatible AI) the ability to find and execute cross-chain bridge transfers — with automatic route optimization, fee comparison, balance checks, and safety warnings.

**Latest npm release:** `@persistenceone/bridgekitty@0.3.5`

## What's New in v0.3.5

- Patch release — version alignment across npm package, MCP registry manifest (`server.json`), and docs.

<details>
<summary>What's New in v0.3.0</summary>

- **`sign_and_send` parameter** — agents can now sign and broadcast transactions directly using locally-stored wallet keys
- **Full EVM signing support** — works with all EVM backends (Across, Relay, LI.FI, Squid, deBridge) + Persistence Interop (EIP-712)
- **Simulation fix** — ERC20 bridges now work on fresh wallets (previously blocked by premature simulation)
- **Solana signing** — coming in next release

</details>

<details>
<summary>What's New in v0.2.0</summary>

- **Solana support** — bidirectional bridging EVM ↔ Solana (native SOL delivery, not wrapped)
- **Cosmos support** — EVM → Persistence/Cosmos Hub via Squid (Axelar)
- **Protocol fee transparency** — deBridge fixFee, operating expenses, and total cost visible in every quote
- **Balance warnings** — warns when wallet can't cover bridge amount + protocol fees + gas
- **XPRT staking** — stake/unstake/claim rewards directly from the MCP server
- **Farming multiplier** — tracks your staking tier (1x → 3x → 5x) from the rewards API
- **Quote auto-refresh** — expired quotes automatically re-fetched on execute (60s expiry)
- **ERC-20 approvals** — always generated for token bridges (Relay + deBridge)
- **Bridge status tracking** — on-chain fallback when provider API hasn't indexed yet

</details>

## Supported Bridges

| Backend | Type | Chains | Strength |
|---------|------|--------|----------|
| **deBridge (DLN)** | Direct | EVM + Solana | Fast intent-based fills, Solana support |
| **Relay** | Direct | EVM + Solana | No protocol fee, gas-optimized |
| **LI.FI** | Aggregator | EVM | Widest coverage (30+ bridges, any-to-any swap) |
| **Across** | Direct | EVM | Fastest fills (~6s), same-token bridging |
| **Squid (Axelar)** | Aggregator | EVM + Cosmos | Only option for EVM → Cosmos routes |

### Bridge Directions

| Direction | Backends | Status |
|-----------|----------|--------|
| EVM → EVM | All 5 | ✅ Production |
| EVM → Solana | deBridge, Relay | ✅ Production |
| Solana → EVM | deBridge | ✅ Production |
| EVM → Cosmos | Squid | ✅ Production |

## Quick Start

### npx (zero install)

```bash
npx @persistenceone/bridgekitty
```

### Claude Code

Add to your MCP config (`~/.claude/claude_code_config.json`):

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

### Cursor IDE

Add to Cursor's MCP settings (Settings > MCP Servers):

```json
{
  "bridgekitty": {
    "command": "npx",
    "args": ["@persistenceone/bridgekitty"]
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
      "args": ["@persistenceone/bridgekitty"]
    }
  }
}
```

## Wallet Setup

BridgeKitty can manage wallets for autonomous bridging. Run `wallet_setup` to create wallets for EVM, Cosmos, and Solana — or provide your own addresses in quotes.

Wallet config is stored in `~/.bridgekitty/.env` (or the directory you run from). Keys never leave the local machine.

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | EVM private key (hex) |
| `MNEMONIC` | BIP-39 mnemonic (derives EVM, Cosmos, Solana keys) |
| `SOLANA_PRIVATE_KEY` | Solana private key (base58) |

## Transaction Signing

By default, `bridge_execute` returns unsigned transactions for the agent or user to sign externally.

Set `sign_and_send: true` to enable autonomous signing — BridgeKitty will use the wallet keys stored in `~/.bridgekitty/.env` to handle the full flow:

1. **Approval** — sends ERC-20 approval transaction (if needed)
2. **Re-build** — re-fetches the bridge transaction with updated nonce (if approval was sent)
3. **Simulate** — runs `eth_estimateGas` pre-flight check
4. **Sign** — signs the transaction with the local private key
5. **Broadcast** — submits to the chain and returns the tx hash + explorer link

**Persistence Interop** uses EIP-712 typed data signing (Permit2 approval + on-chain initiate) instead of standard approve-and-send.

### Optional API Keys

| Variable | Description |
|----------|-------------|
| `LIFI_API_KEY` | LI.FI API key (higher rate limits) |
| `DEBRIDGE_API_KEY` | deBridge API key |
| `SQUID_INTEGRATOR_ID` | Squid integrator ID |

## MCP Tools

### Core Bridge Tools

| Tool | Description |
|------|-------------|
| `bridge_get_quote` | Get competitive quotes from all backends. Shows fees, time estimates, balance warnings. |
| `bridge_execute` | Build transaction(s) from a quote. Handles approvals, auto-refreshes expired quotes. Set `sign_and_send: true` to auto-sign and broadcast. |
| `bridge_status` | Track bridge progress. On-chain fallback when API hasn't indexed yet. |
| `bridge_chains` | List supported chains with provider coverage. |
| `bridge_tokens` | Search tokens on a chain. |

### Wallet Tools

| Tool | Description |
|------|-------------|
| `wallet_setup` | Create wallets for EVM, Cosmos, Solana from a single mnemonic. |
| `wallet_balance` | Check balances across all chains with USD prices (CoinGecko). |

### XPRT Staking & Farming

| Tool | Description |
|------|-------------|
| `xprt_stake` | Stake XPRT to a validator (warns about 21-day unbonding). |
| `xprt_unstake` | Unstake XPRT (21-day unbonding period). |
| `xprt_claim_rewards` | Claim staking rewards. |
| `xprt_rewards_check` | Check farming rewards, multiplier tier, epoch status. |
| `xprt_farm_start` | Start automated BTC round-trip farming (cbBTC ↔ BTCB). |
| `xprt_farm_boost` | Buy + stake XPRT for multiplier boost (1x → 3x → 5x). |
| `bridgekitty_help` | Full docs on farming tiers, multipliers, and strategy. |

## Example: Bridge USDC from Base to Arbitrum

### Default (unsigned transactions)

```
Agent: "Bridge 100 USDC from Base to Arbitrum"

→ bridge_get_quote: Gets quotes from deBridge, Relay, LI.FI, Across
→ Shows: best rate, fees, estimated time, balance check
→ bridge_execute: Builds approval tx + bridge tx
→ Agent signs and sends both transactions
→ bridge_status: Tracks until destination confirmed
```

### With sign_and_send (autonomous signing)

```
Agent: "Bridge 100 USDC from Base to Arbitrum"

→ bridge_get_quote: Gets quotes from all backends
→ bridge_execute with sign_and_send: true
  → Auto-signs approval tx + bridge tx using local wallet keys
  → Returns tx hash + explorer link
→ bridge_status: Tracks until destination confirmed
```

## Architecture

```
Agent → MCP Tools → Routing Engine → [deBridge, Relay, LI.FI, Across, Squid]
                         ↓
                   Quote Cache (60s) + Circuit Breaker
                         ↓
                   Best Quote → buildTransaction
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        Unsigned TX          Signed + Broadcast
         (default)            (sign_and_send)
```

- **Routing Engine:** Parallel quotes from all backends, ranked by output amount
- **Circuit Breaker:** Auto-skips failing backends, gradual recovery
- **Token Registry:** 45+ verified tokens with canonical addresses per chain
- **Gas Estimator:** Chain-aware gas cost estimation with multi-RPC failover
- **Balance Checker:** Validates token + native balance for fees before execution
- **Fee Transparency:** Protocol fees (deBridge fixFee, operating expenses) surfaced in every quote

## Security

- Exact-amount approvals only (never unlimited)
- Transaction simulation before execution
- Verified token registry prevents address spoofing
- No private keys in MCP protocol — agents sign transactions externally
- `sign_and_send` uses locally-stored keys only (never transmitted over the network)
- Circuit breaker prevents cascading failures
- Error messages sanitized (no key/path leakage)
- `.env` file permission checks + overwrite protection

## Known Limitations

- **Solana → EVM** returns a serialized transaction for external signing (no auto-execute)
- **Relay status tracking** may show "unknown" for completed cross-chain bridges
- **Solana SPL tokens** not yet shown in `wallet_balance` (only native SOL)
- **Cosmos → EVM** bridging not yet supported (only EVM → Cosmos)

## License

MIT
