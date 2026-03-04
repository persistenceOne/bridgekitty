# CLAUDE.md — BridgeKitty Project Context

## What is this?

BridgeKitty is a **cross-chain bridge aggregator MCP server** for AI agents. It gives Claude, GPT, Cursor, or any MCP-compatible AI the ability to find and execute cross-chain bridge transfers. Think "1inch for bridges, but the user is an AI agent."

**One MCP server → 6 bridge backends → best routes across EVM, Cosmos, and Solana chains.**

The hook: any-to-any bridging for agents across all major ecosystems. The sticky feature: XPRT farming rewards (earn XPRT by bridging BTC variants via Persistence Interop).

## Architecture

```
src/
├── index.ts                  # Entry point — MCP server setup, backend init
├── routing/engine.ts         # Multi-backend routing engine (parallel quotes, ranking)
├── backends/                 # Bridge provider integrations
│   ├── types.ts              # Shared interfaces (BridgeQuote, TransactionRequest, etc.)
│   ├── lifi.ts               # LI.FI aggregator (30+ bridges, widest coverage)
│   ├── squid.ts              # Squid Router (cross-ecosystem: EVM ↔ Cosmos ↔ Solana)
│   ├── debridge.ts           # deBridge DLN (fast intents, Solana support)
│   ├── across.ts             # Across (fastest fills ~6s)
│   ├── relay.ts              # Relay (gas-optimized)
│   └── persistence.ts        # Persistence Interop (BTCB↔cbBTC, XPRT rewards)
├── tools/                    # MCP tool definitions (what the AI agent calls)
│   ├── get-quote.ts          # bridge_get_quote — multi-backend quote comparison
│   ├── execute-bridge.ts     # bridge_execute — returns unsigned tx data
│   ├── check-status.ts       # bridge_status — track bridge progress
│   ├── get-chains.ts         # bridge_chains — list supported chains
│   ├── get-tokens.ts         # bridge_tokens — list tokens per chain
│   ├── multi-quote.ts        # bridge_quote_multi — multi-hop route resolution
│   ├── help.ts               # bridgekitty_help — agent onboarding guide
│   ├── xprt-rewards.ts       # xprt_rewards_check — reward accrual visibility
│   ├── onboard.ts            # xprt_onboard — guided onboarding flow
│   ├── wallet.ts             # wallet_setup + wallet_balance (with USD valuations)
│   └── xprt-farm.ts          # xprt_farm_* (prepare/start/status/boost with dry-run)
└── utils/                    # Shared utilities
    ├── token-registry.ts     # Curated verified token addresses (anti-phishing)
    ├── chains.ts             # Chain ID → name/RPC mapping
    ├── circuit-breaker.ts    # Per-backend circuit breaker
    ├── gas-estimator.ts      # Gas cost estimation in USD (multi-RPC failover)
    ├── evm.ts                # ERC20 approve helpers
    ├── tokens.ts             # Token amount formatting
    ├── tx-simulator.ts       # eth_estimateGas pre-flight checks
    └── sanitize-error.ts     # Strip sensitive info from errors
```

## Key Design Decisions

1. **MCP only returns unsigned transactions.** The `bridge_execute` tool returns tx data for the agent/user to sign. NO server-side signing in the MCP flow. Exception: `xprt-farm.ts` tools do sign server-side because they're opt-in reward farming flows.

2. **Persistence backend uses EIP-712 + Permit2**, not standard approve→swap. The `signAndExecute()` method handles the full flow: Permit2 approval → EIP-712 signing → on-chain initiate → backend submit. Includes nonce-collision retry (up to 2 retries with fresh nonce).

3. **Integrator fees are hardcoded**, not in `.env`. See `src/index.ts` — `BRIDGEKITTY_FEE_WALLET`, `BRIDGEKITTY_DEBRIDGE_FEE`, etc. Users can't change/remove our fee addresses.

4. **Wallet setup derives all chains from one mnemonic.** EVM (BIP-44 m/44'/60'/0'/0/0), Cosmos (persistence prefix), Solana (BIP-44 m/44'/501'/0'/0'). Keys saved to `.env` in CWD.

5. **Token registry is curated and hardcoded** (`src/utils/token-registry.ts`). Unknown symbols are rejected. Prevents phishing via malicious token contracts.

6. **In-memory key store (H-1).** Keys are moved from `process.env` to an in-memory store at startup and cleared from the environment immediately.

## Wallets

| Wallet | Address | Purpose |
|--------|---------|---------|
| Integrator Fee | `0xb24aCFcda187135490d81517ab56709FdDe6a81A` | Bridge integrator fees |
| Test Wallet | `0x221726819bcfDDC3B05be56369a14ac836E64B7F` | E2E testing |

Keys are in `.env`. Never committed. `.gitignore` covers them.

## Commands

```bash
npm run build          # TypeScript → dist/
npm run start          # Run MCP server (stdio)
npm run dev            # Dev mode with tsx
```

## Testing

Quotes work with zero config:
```bash
node -e 'import("./dist/backends/lifi.js").then(async ({LiFiBackend}) => { const b = new LiFiBackend(); const q = await b.getQuote({ fromChainId: 8453, toChainId: 42161, fromTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", toTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amountRaw: "1000000", fromAddress: "0x0000000000000000000000000000000000000001", preference: "cheapest" }); console.log(q ? "OK: " + q.outputAmount + " USDC" : "FAIL"); })'
```

## APIs Used

| API | Base URL | Auth |
|-----|----------|------|
| LI.FI | `https://li.quest/v1/` | None (or `LIFI_API_KEY`) |
| Squid Router | `https://v2.api.squidrouter.com/` | None (or `SQUID_INTEGRATOR_ID`) |
| deBridge | `https://api.dln.trade/v1.0/` | None |
| Across | `https://app.across.to/api/` | None |
| Relay | `https://api.relay.link/` | None |
| Persistence Interop | `https://api.interop.persistence.one` | None |
| Persistence Rewards | `https://rewards.interop.persistence.one` | None |

## Security

Key security properties:
- Exact approvals only (never unlimited)
- Verified token registry (no unverified resolution)
- Transaction simulation before return (and before server-side signing in xprt-farm)
- Amount caps on Persistence (0.00005–0.001 BTC)
- Circuit breakers per backend
- Sanitized error messages (no key/path/mnemonic/base58 leakage)
- `.env` overwrite protection + permission checks
- Quote execution locking (no double-spend)
- In-memory key store (keys cleared from process.env at startup)

## Next Steps

1. **Publish to npm** — enables `npx bridgekitty` zero-install experience
2. **Register integrator IDs** — LI.FI (portal.li.fi)
3. **List on MCP registries** — mcp.so, Smithery, Cursor directory
4. **GitHub repo** — push to persistenceOne org
