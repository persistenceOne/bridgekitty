# CLAUDE.md — BridgeKitty Project Context

## What is this?

BridgeKitty is a **cross-chain bridge aggregator MCP server** for AI agents. It gives Claude, GPT, Cursor, or any MCP-compatible AI the ability to find and execute cross-chain bridge transfers. Think "1inch for bridges, but the user is an AI agent."

**One MCP server → 6 bridge backends → best routes across 100+ chains.**

The hook: any-to-any bridging for agents. The sticky feature: Persistence Interop rewards (earn XPRT by bridging BTC variants).

## Architecture

```
src/
├── index.ts                  # Entry point — MCP server setup, backend init
├── routing/engine.ts         # Multi-backend routing engine (parallel quotes, ranking)
├── backends/                 # Bridge provider integrations
│   ├── types.ts              # Shared interfaces (BridgeQuote, TransactionRequest, etc.)
│   ├── lifi.ts               # LI.FI aggregator (30+ bridges, widest coverage)
│   ├── squid.ts              # Squid Router (89 chains incl. 62 Cosmos)
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
│   ├── wallet.ts             # wallet_setup + wallet_balance
│   └── persistence-rewards.ts # persistence_rewards_* (prepare/start/status/boost)
├── utils/                    # Shared utilities
│   ├── token-registry.ts     # Curated verified token addresses (anti-phishing)
│   ├── chains.ts             # Chain ID → name/RPC mapping
│   ├── circuit-breaker.ts    # Per-backend circuit breaker
│   ├── gas-estimator.ts      # Gas cost estimation in USD
│   ├── evm.ts                # ERC20 approve helpers
│   ├── tokens.ts             # Token amount formatting
│   ├── tx-simulator.ts       # eth_estimateGas pre-flight checks
│   └── sanitize-error.ts     # Strip sensitive info from errors
└── acp/                      # Virtuals ACP integration (agent-to-agent commerce)
    ├── index.ts              # ACP mode entry point
    ├── handler.ts            # Job handler
    ├── listener.ts           # On-chain event listener
    ├── registration.ts       # Service registration
    └── types.ts              # ACP config types
```

## Key Design Decisions

1. **MCP only returns unsigned transactions.** The `bridge_execute` tool returns tx data for the agent/user to sign. NO server-side signing in the MCP flow (security audit C-2). Exception: `persistence-rewards.ts` tools do sign server-side because they're opt-in reward farming flows.

2. **Persistence backend uses EIP-712 + Permit2**, not standard approve→swap. The `signAndExecute()` method handles the full flow: Permit2 approval → EIP-712 signing → on-chain initiate → backend submit.

3. **Integrator fees are hardcoded**, not in `.env`. See `src/index.ts` top — `BRIDGEKITTY_FEE_WALLET`, `BRIDGEKITTY_DEBRIDGE_FEE`, etc. Users can't change/remove our fee addresses.

4. **Wallet setup derives all chains from one mnemonic.** EVM (BIP-44 m/44'/60'/0'/0/0), Cosmos (persistence prefix), Solana (BIP-44 m/44'/501'/0'/0'). Keys saved to `.env` in CWD.

5. **Token registry is curated and hardcoded** (`src/utils/token-registry.ts`). Unknown symbols are rejected. Prevents phishing via malicious token contracts.

6. **Squid two-phase build.** Squid's API bakes nonces into responses. If approval is needed, `buildTransaction()` returns the approval + sets `needsPostApprovalBuild=true`. After approval confirms, call `buildBridgeTransaction()` to get fresh tx data.

## Wallets

| Wallet | Address | Purpose |
|--------|---------|---------|
| Wallet 1 (ACP Service) | `0x717708db02c059eE9b8807B866850DcA90f88b60` | ACP escrow fees |
| Wallet 2 (Integrator) | `0xb24aCFcda187135490d81517ab56709FdDe6a81A` | Bridge integrator fees |
| Wallet 3 (Test Buyer) | `0x221726819bcfDDC3B05be56369a14ac836E64B7F` | E2E testing |

Keys are in `.env` and `.env.acp`. Backup at `/Users/persistence/projects/.secrets-backup-20260227/`.

## Environment Files

- `.env` — Main config (PRIVATE_KEY for test wallet, integrator addresses)
- `.env.acp` — ACP integration config (all 3 wallet keys, ACP settings)
- Neither should ever be committed. `.gitignore` covers them.

## Commands

```bash
npm run build          # TypeScript → dist/
npm run start          # Run MCP server (stdio)
npm run dev            # Dev mode with tsx
npm run start:acp      # ACP mode (agent-to-agent commerce)
```

## Testing

Quotes work with zero config:
```bash
node -e 'import("./dist/backends/lifi.js").then(async ({LiFiBackend}) => { const b = new LiFiBackend(); const q = await b.getQuote({ fromChainId: 8453, toChainId: 42161, fromTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", toTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amountRaw: "1000000", fromAddress: "0x0000000000000000000000000000000000000001", preference: "cheapest" }); console.log(q ? "OK: " + q.outputAmount + " USDC" : "FAIL"); })'
```

E2E test results in `test-e2e-results-round3.md`. All 6 backends verified working.

## APIs Used

| API | Base URL | Auth |
|-----|----------|------|
| LI.FI | `https://li.quest/v1/` | None (or `LIFI_API_KEY`) |
| Squid | `https://v2.api.squidrouter.com/v2/` | `x-integrator-id` header |
| deBridge | `https://deswap.debridge.finance/v1.0/` | None |
| Across | `https://app.across.to/api/` | None |
| Relay | `https://api.relay.link/` | None |
| Persistence Interop | `https://api.interop.persistence.one` | None |
| Persistence Rewards | `https://rewards.interop.persistence.one` | None |

## Known Issues

1. **Permit2 nonce collision**: When `initiate()` reverts on Persistence backend, the Permit2 approval is consumed but the order fails. Next attempt with same nonce works because allowance persists. ~50% of first attempts after a failure will fail, retry succeeds.

2. **Gas estimator fallback**: `eth_gasPrice` sometimes fails for Base/BSC chains. Fallback prices used (may be stale).

3. **LI.FI USDC→cbBTC swap**: `TRANSFER_FROM_FAILED` on same-chain swaps via LiFi — approval goes to wrong spender in multi-hop routes. Not critical (cross-chain works fine).

## Security

Full audit report: `SECURITY-AUDIT.md`
Fix summary: `SECURITY-FIXES.md`

Key security properties:
- Exact approvals only (never unlimited)
- Verified token registry (no unverified resolution)
- Transaction simulation before return
- Amount caps on Persistence (0.00005–0.001 BTC)
- Circuit breakers per backend
- Sanitized error messages (no key/path leakage)
- `.env` overwrite protection
- Quote execution locking (no double-spend)

## Next Steps

1. **Publish to npm** — enables `npx bridgekitty` zero-install experience
2. **Fix Permit2 nonce handling** — avoid the retry-needed pattern
3. **Register integrator IDs** — LI.FI (portal.li.fi), Squid (squidrouter.typeform.com)
4. **List on MCP registries** — mcp.so, Smithery, Cursor directory
5. **GitHub repo** — push to persistenceOne org (or separate org)
