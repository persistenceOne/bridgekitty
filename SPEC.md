# BridgeKitty — Technical Spec

**Author:** Forge ⚒️ (Head of Engineering, Persistence Labs)  
**Date:** 2026-02-19  
**Status:** DRAFT — Pending Dneorej review

---

## 1. Executive Summary

A single MCP server that any AI agent can install to bridge tokens across chains. It aggregates multiple bridge backends (LI.FI, deBridge, Across, Relay, Persistence Interop), queries them in parallel, and returns the best route. The agent calls one tool. Done.

**Why this wins:** No other MCP server does cross-chain bridge aggregation. Agents today have zero bridging tools. First mover captures the entire agent-bridging market.

---

## 2. Bridge Backend Analysis

### 2.1 LI.FI (Priority: ★★★★★ — Ship first)

| Attribute | Details |
|-----------|---------|
| **Base URL** | `https://li.quest/v1` |
| **Auth** | API key via `x-lifi-api-key` header. Free tier available (rate-limited). |
| **Quote** | `GET /v1/quote?fromChain=&toChain=&fromToken=&toToken=&fromAddress=&fromAmount=` |
| **Advanced routes** | `POST /v1/advanced/routes` (multi-step, multi-bridge) |
| **Execution** | Returns `transactionRequest` (to, data, value, gasLimit) — agent signs & sends |
| **Status** | `GET /v1/status?txHash=&bridge=&fromChain=&toChain=` |
| **Chains** | `GET /v1/chains` |
| **Tokens** | `GET /v1/tokens?chains=` |
| **Tools** | `GET /v1/tools` (lists all bridges & DEXes) |
| **Coverage** | 35+ chains, 27+ bridges (Stargate, Hop, Across, Celer, etc.), 15+ DEX aggregators |
| **Rate limits** | Free: 10 req/s. With API key: higher. |
| **Fee model** | `integrator` + `fee` params on quote — up to 4% integrator fee on each tx |
| **Integration effort** | ~200 LOC. Easiest — single API covers everything. |
| **Notes** | LI.FI is itself an aggregator. Wrapping it alone gives 80% coverage. |

### 2.2 deBridge / DLN (Priority: ★★★★☆)

| Attribute | Details |
|-----------|---------|
| **Base URL** | `https://api.dln.trade/v1.0` |
| **Auth** | No API key required for public endpoints |
| **Quote** | `GET /dln/order/quote?srcChainId=&srcChainTokenIn=&dstChainId=&dstChainTokenOut=&srcChainTokenInAmount=&prependOperatingExpenses=true` |
| **Create TX** | `GET /dln/order/create-tx?...` (returns calldata) |
| **Status** | `GET /dln/order/{orderId}/status` |
| **Coverage** | 15+ chains including Solana, EVM chains |
| **Unique** | Intent-based (like Persistence Interop). Sub-minute fills. Solana support. |
| **Integration effort** | ~250 LOC |

### 2.3 Across Protocol (Priority: ★★★☆☆)

| Attribute | Details |
|-----------|---------|
| **Base URL** | `https://app.across.to/api` |
| **Auth** | No API key for public endpoints |
| **Quote** | `GET /suggested-fees?token=&destinationChainId=&amount=&originChainId=` |
| **Deposit** | Smart contract interaction via `SpokePool.depositV3()` — requires ABI encoding |
| **Status** | `GET /deposit/status?originChainId=&depositId=&depositTxHash=` |
| **Coverage** | EVM only, ~10 chains. Fast fills (~seconds for intents). |
| **Unique** | Optimistic oracle verification. Very competitive fees for L2→L2. |
| **Integration effort** | ~400 LOC (needs contract ABI interaction for deposit, not just REST) |
| **Notes** | More complex — quote is REST but execution requires building contract tx |

### 2.4 Relay (Priority: ★★★★☆)

| Attribute | Details |
|-----------|---------|
| **Base URL** | `https://api.relay.link` |
| **Auth** | No API key. Optional `referrer` param. |
| **Quote** | `POST /quote/v2` with JSON body: `{user, originChainId, destinationChainId, originCurrency, destinationCurrency, amount, tradeType}` |
| **Execute** | `POST /execute` — gasless execution available |
| **Status** | `GET /intents/status/v3?requestId=` |
| **Chains** | `GET /chains` |
| **Currencies** | `GET /currencies/v2?chainId=` |
| **Multi-input** | `POST /swap/multi-input` — swap from multiple origins to one destination |
| **Coverage** | 20+ chains including Bitcoin. Sub-second fills. |
| **Unique** | Gasless execution, multi-input swaps, Bitcoin support |
| **Integration effort** | ~250 LOC |

### 2.5 Persistence Interop Solver (Priority: ★★★★★ — Already built)

| Attribute | Details |
|-----------|---------|
| **Base URL** | `https://api.interop.persistence.one` |
| **Auth** | TBD (existing MCP server has access) |
| **Quote** | `POST /quotes/request` |
| **Execute** | `POST /orders/submit-with-tx` |
| **Coverage** | BTC cross-chain swaps on Base/BSC via intent/solver model |
| **Integration effort** | ~0 LOC (already done) |

### Integration Priority Matrix

| Phase | Backends | Why |
|-------|----------|-----|
| **MVP (Week 1)** | LI.FI + Persistence Interop | LI.FI alone = 35 chains, 27 bridges. Our solver adds BTC intent routes. |
| **V1 (Week 2-3)** | + Relay + deBridge | Better pricing via competition, Solana via deBridge, gasless via Relay |
| **V1.5 (Week 4)** | + Across | Best L2↔L2 rates, but more complex integration |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│                   MCP Client (Agent)                │
│         (Claude, GPT, Eliza, custom agent)          │
└──────────────────────┬──────────────────────────────┘
                       │ MCP Protocol (stdio/SSE)
┌──────────────────────▼──────────────────────────────┐
│                BridgeKitty Server                    │
│                                                     │
│  ┌───────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Tool Layer│  │ Routing  │  │  Status Tracker   │ │
│  │ (5 tools) │→ │ Engine   │  │  (poll + webhook) │ │
│  └───────────┘  └────┬─────┘  └──────────────────┘ │
│                      │                              │
│  ┌───────────────────▼──────────────────────────┐   │
│  │            Backend Adapter Layer              │   │
│  │  ┌──────┐ ┌───────┐ ┌─────┐ ┌─────┐ ┌────┐  │   │
│  │  │LI.FI│ │deBridge│ │Relay│ │Across│ │Pstk│  │   │
│  │  └──────┘ └───────┘ └─────┘ └─────┘ └────┘  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 3.1 Tech Stack

```json
{
  "runtime": "Node.js 20+ / Bun",
  "language": "TypeScript 5.x",
  "framework": "@modelcontextprotocol/sdk",
  "http": "undici (native fetch)",
  "validation": "zod",
  "dependencies": [
    "@modelcontextprotocol/sdk",
    "zod",
    "viem"
  ],
  "devDependencies": [
    "typescript",
    "vitest",
    "tsup"
  ],
  "estimatedTotalLOC": "1500-2000 (MVP: ~600)"
}
```

### 3.2 Directory Structure

```
bridgekitty/
├── src/
│   ├── index.ts              # MCP server entry
│   ├── tools/
│   │   ├── get-quote.ts      # Quote aggregation tool
│   │   ├── execute-bridge.ts # Execute bridge tool
│   │   ├── check-status.ts   # Status checking tool
│   │   ├── get-chains.ts     # Supported chains tool
│   │   └── get-tokens.ts     # Supported tokens tool
│   ├── backends/
│   │   ├── types.ts          # Shared interface
│   │   ├── lifi.ts           # LI.FI adapter
│   │   ├── debridge.ts       # deBridge adapter
│   │   ├── relay.ts          # Relay adapter
│   │   ├── across.ts         # Across adapter
│   │   └── persistence.ts    # Persistence Interop adapter
│   ├── routing/
│   │   └── engine.ts         # Parallel query + ranking
│   └── utils/
│       ├── chains.ts         # Chain ID registry
│       └── tokens.ts         # Common token addresses
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. MCP Tool Definitions

### 4.1 `bridge_get_quote`

```typescript
server.tool(
  "bridge_get_quote",
  "Get the best bridge quote across multiple protocols. Returns ranked options by output amount, speed, and estimated fees.",
  {
    fromChain: z.string().describe("Source chain (e.g. 'ethereum', 'base', 'arbitrum', or chain ID like '1', '8453')"),
    toChain: z.string().describe("Destination chain"),
    fromToken: z.string().describe("Token to send (symbol like 'USDC' or contract address)"),
    toToken: z.string().describe("Token to receive (symbol like 'USDC' or contract address)"),
    amount: z.string().describe("Amount in human-readable units (e.g. '100' for 100 USDC)"),
    fromAddress: z.string().describe("Sender wallet address"),
    toAddress: z.string().optional().describe("Recipient address (defaults to fromAddress)"),
    preference: z.enum(["cheapest", "fastest"]).default("cheapest").describe("Optimize for cost or speed"),
  },
  async (params) => {
    // 1. Normalize chain names → chain IDs
    // 2. Resolve token symbols → addresses + decimals
    // 3. Convert human amount → raw amount (with decimals)
    // 4. Query all backends in parallel with Promise.allSettled
    // 5. Normalize responses, rank, return top 3
    const quotes = await routingEngine.getQuotes(params);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bestQuote: quotes[0],
          alternatives: quotes.slice(1, 3),
          summary: `Best: ${quotes[0].outputAmount} ${params.toToken} via ${quotes[0].provider} ` +
                   `(fee: $${quotes[0].estimatedFeeUsd}, ETA: ${quotes[0].estimatedTimeSeconds}s)`
        }, null, 2)
      }]
    };
  }
);
```

### 4.2 `bridge_execute`

```typescript
server.tool(
  "bridge_execute",
  "Execute a bridge transfer. Returns the transaction data to sign, or executes directly if a signer is configured.",
  {
    quoteId: z.string().describe("Quote ID from bridge_get_quote"),
    // OR manual params for direct execution:
    fromChain: z.string().optional(),
    toChain: z.string().optional(),
    fromToken: z.string().optional(),
    toToken: z.string().optional(),
    amount: z.string().optional(),
    fromAddress: z.string().optional(),
    toAddress: z.string().optional(),
    slippage: z.number().default(0.005).describe("Max slippage (0.005 = 0.5%)"),
  },
  async (params) => {
    // 1. Look up cached quote by quoteId (or fetch fresh)
    // 2. Get transaction data from the winning backend
    // 3. Return unsigned tx for agent to sign, OR sign if private key configured
    const txRequest = await routingEngine.buildTransaction(params);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          transactionRequest: {
            to: txRequest.to,
            data: txRequest.data,
            value: txRequest.value,
            chainId: txRequest.chainId,
            gasLimit: txRequest.gasLimit,
          },
          approvalNeeded: txRequest.approvalTx ?? null,
          provider: txRequest.provider,
          instructions: txRequest.approvalTx
            ? "First send the approval transaction, then send the bridge transaction."
            : "Sign and send this transaction to initiate the bridge.",
          trackingId: txRequest.trackingId,
        }, null, 2)
      }]
    };
  }
);
```

### 4.3 `bridge_status`

```typescript
server.tool(
  "bridge_status",
  "Check the status of a bridge transfer. Returns human-readable progress.",
  {
    trackingId: z.string().optional().describe("Tracking ID from bridge_execute"),
    txHash: z.string().optional().describe("Source chain transaction hash"),
    fromChain: z.string().optional().describe("Required with txHash"),
    provider: z.string().optional().describe("Bridge provider name"),
  },
  async (params) => {
    const status = await statusTracker.check(params);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: status.state, // "pending" | "in_progress" | "completed" | "failed" | "refunded"
          summary: status.humanReadable,
          sourceTx: status.sourceTxHash,
          destinationTx: status.destTxHash,
          provider: status.provider,
          elapsedSeconds: status.elapsed,
          estimatedRemainingSeconds: status.estimatedRemaining,
        }, null, 2)
      }]
    };
  }
);
```

### 4.4 `bridge_chains`

```typescript
server.tool(
  "bridge_chains",
  "List all supported chains and which bridge providers cover them.",
  {},
  async () => {
    const chains = await chainRegistry.getAll();
    // Returns: [{ id: 1, name: "Ethereum", key: "ethereum", providers: ["lifi", "relay", "across", "debridge"] }, ...]
    return { content: [{ type: "text", text: JSON.stringify(chains, null, 2) }] };
  }
);
```

### 4.5 `bridge_tokens`

```typescript
server.tool(
  "bridge_tokens",
  "List popular tokens available for bridging on a given chain.",
  {
    chain: z.string().describe("Chain name or ID"),
    search: z.string().optional().describe("Filter by token name or symbol"),
  },
  async (params) => {
    const tokens = await tokenRegistry.getForChain(params.chain, params.search);
    return { content: [{ type: "text", text: JSON.stringify(tokens, null, 2) }] };
  }
);
```

---

## 5. Backend Adapter Interface

```typescript
// src/backends/types.ts

export interface BridgeQuote {
  provider: string;            // "lifi" | "debridge" | "relay" | "across" | "persistence"
  outputAmount: string;        // Human-readable output amount
  outputAmountRaw: string;     // Raw amount (wei etc.)
  estimatedFeeUsd: number;     // Total cost in USD (gas + protocol fees)
  estimatedTimeSeconds: number;
  route: string;               // Human description: "USDC → Stargate → USDC"
  quoteData: unknown;          // Opaque backend-specific data for execution
  expiresAt: number;           // Unix timestamp
}

export interface TransactionRequest {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  approvalTx?: { to: string; data: string; value: string; chainId: number };
  provider: string;
  trackingId: string;
}

export interface BridgeStatus {
  state: "pending" | "in_progress" | "completed" | "failed" | "refunded";
  humanReadable: string;
  sourceTxHash?: string;
  destTxHash?: string;
  provider: string;
  elapsed: number;
  estimatedRemaining?: number;
}

export interface BridgeBackend {
  name: string;
  getQuote(params: QuoteParams): Promise<BridgeQuote | null>;
  buildTransaction(quote: BridgeQuote): Promise<TransactionRequest>;
  getStatus(trackingId: string): Promise<BridgeStatus>;
  getSupportedChains(): Promise<ChainInfo[]>;
}
```

### Example: LI.FI Adapter (core logic)

```typescript
// src/backends/lifi.ts
const LIFI_BASE = "https://li.quest/v1";

export class LiFiBackend implements BridgeBackend {
  name = "lifi";

  async getQuote(params: QuoteParams): Promise<BridgeQuote | null> {
    const url = new URL(`${LIFI_BASE}/quote`);
    url.searchParams.set("fromChain", String(params.fromChainId));
    url.searchParams.set("toChain", String(params.toChainId));
    url.searchParams.set("fromToken", params.fromTokenAddress);
    url.searchParams.set("toToken", params.toTokenAddress);
    url.searchParams.set("fromAmount", params.amountRaw);
    url.searchParams.set("fromAddress", params.fromAddress);
    url.searchParams.set("order", params.preference === "fastest" ? "FASTEST" : "CHEAPEST");
    url.searchParams.set("slippage", "0.005");
    url.searchParams.set("integrator", "persistence-bridge-agg");
    url.searchParams.set("fee", "0.003"); // 0.3% integrator fee

    const res = await fetch(url.toString(), {
      headers: this.apiKey ? { "x-lifi-api-key": this.apiKey } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();

    return {
      provider: "lifi",
      outputAmount: formatUnits(data.estimate.toAmount, data.action.toToken.decimals),
      outputAmountRaw: data.estimate.toAmount,
      estimatedFeeUsd: data.estimate.gasCosts?.reduce((s, g) => s + Number(g.amountUSD), 0) ?? 0,
      estimatedTimeSeconds: data.estimate.executionDuration,
      route: `${data.action.fromToken.symbol} → ${data.toolDetails?.name ?? "LI.FI"} → ${data.action.toToken.symbol}`,
      quoteData: data, // Full LI.FI response for buildTransaction
      expiresAt: Date.now() + 60_000,
    };
  }

  async buildTransaction(quote: BridgeQuote): Promise<TransactionRequest> {
    const data = quote.quoteData as any;
    const txReq = data.transactionRequest;
    return {
      to: txReq.to,
      data: txReq.data,
      value: txReq.value,
      chainId: txReq.chainId,
      gasLimit: txReq.gasLimit,
      provider: "lifi",
      trackingId: `lifi:${data.tool}:${Date.now()}`,
    };
  }

  async getStatus(trackingId: string): Promise<BridgeStatus> {
    // Parse txHash from trackingId or cached mapping
    const url = `${LIFI_BASE}/status?txHash=${txHash}&fromChain=${fromChain}&toChain=${toChain}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      state: mapLifiStatus(data.status), // "DONE" → "completed", etc.
      humanReadable: `Bridge via ${data.tool}: ${data.status}`,
      sourceTxHash: data.sending?.txHash,
      destTxHash: data.receiving?.txHash,
      provider: "lifi",
      elapsed: Math.floor((Date.now() - data.sending?.timestamp * 1000) / 1000),
    };
  }
}
```

---

## 6. Routing Engine

```typescript
// src/routing/engine.ts

export class RoutingEngine {
  constructor(private backends: BridgeBackend[]) {}

  async getQuotes(params: NormalizedQuoteParams): Promise<BridgeQuote[]> {
    // Query ALL backends in parallel
    const results = await Promise.allSettled(
      this.backends.map(b =>
        Promise.race([
          b.getQuote(params),
          new Promise<null>(r => setTimeout(() => r(null), 10_000)) // 10s timeout
        ])
      )
    );

    const quotes = results
      .filter((r): r is PromiseFulfilledResult<BridgeQuote | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((q): q is BridgeQuote => q !== null);

    // Sort by preference
    if (params.preference === "fastest") {
      quotes.sort((a, b) => a.estimatedTimeSeconds - b.estimatedTimeSeconds);
    } else {
      // Cheapest = highest output amount (net of fees)
      quotes.sort((a, b) => Number(b.outputAmountRaw) - Number(a.outputAmountRaw));
    }

    return quotes;
  }
}
```

---

## 7. Execution Model & Key Management

**The server does NOT hold private keys by default.** Three modes:

| Mode | How it works | Use case |
|------|-------------|----------|
| **Unsigned TX** (default) | Returns `transactionRequest` JSON. Agent uses its own wallet/signer. | Most agents (GOAT, Eliza with wallet plugin) |
| **Delegated signing** | Server configured with `PRIVATE_KEY` env var. Signs & broadcasts. | Autonomous agents, server-side bots |
| **Smart account** | Returns UserOperation for ERC-4337 account. | Account-abstracted agents |

```typescript
// Config via env vars
BRIDGE_EXECUTION_MODE=unsigned    // "unsigned" | "sign" | "userop"
PRIVATE_KEY=0x...                 // Only needed for "sign" mode
RPC_URLS='{"1":"https://...","8453":"https://..."}'
```

---

## 8. Agent-Native Differentiation Features

### 8.1 Portfolio-Aware Routing (V1.5)

New tool: `bridge_rebalance`

```typescript
server.tool(
  "bridge_rebalance",
  "Find the optimal way to get a target amount of a token on a destination chain, considering balances across all chains.",
  {
    targetToken: z.string(),
    targetChain: z.string(),
    targetAmount: z.string(),
    walletAddress: z.string(),
  },
  async (params) => {
    // 1. Query balances across all chains (via LI.FI /v1/token/balances)
    // 2. Find cheapest source(s) to fulfill target
    // 3. Return one or more bridge quotes
  }
);
```

### 8.2 Multi-Hop Batching (V1.5)

Relay already supports `POST /swap/multi-input` (multiple origins → one destination). We expose this:

```typescript
server.tool(
  "bridge_consolidate",
  "Bridge tokens from multiple source chains to a single destination.",
  {
    sources: z.array(z.object({
      chain: z.string(),
      token: z.string(),
      amount: z.string(),
    })),
    destinationChain: z.string(),
    destinationToken: z.string(),
    walletAddress: z.string(),
  },
  // ...
);
```

### 8.3 Human-Readable Status Updates

Every status response includes a `humanReadable` field:
- `"✅ Bridge complete! 100 USDC arrived on Base. Tx: 0xabc...def"`
- `"⏳ In progress — tokens locked on Ethereum, waiting for relay (~45s remaining)"`
- `"❌ Bridge failed — insufficient liquidity. Refund initiated on source chain."`

### 8.4 Auto-Retry on Failure

If a bridge fails, `bridge_status` returns `suggestedAction`:
```json
{
  "status": "failed",
  "suggestedAction": "retry_alternative",
  "alternativeQuoteId": "quote_xyz",
  "reason": "Relay solver timeout. deBridge quote available at similar price."
}
```

---

## 9. Fee Model

### 9.1 Revenue Capture

| Mechanism | How | Expected |
|-----------|-----|----------|
| **LI.FI integrator fee** | `fee=0.003` param (0.3%) on every LI.FI quote | Main revenue. $1k volume = $3 rev |
| **deBridge affiliate** | `affiliateFeePercent` param | Similar to LI.FI |
| **Relay referrer** | `referrer` + `referrerAddress` on quotes | Referral rewards |
| **Across referrer** | Referral address in deposit call | Variable |
| **Persistence routes** | Direct margin on solver spread | Already captured |

### 9.2 Pricing Tiers (Future)

| Tier | Price | Limits |
|------|-------|--------|
| **Free** | $0 | 100 quotes/day, 10 executions/day |
| **Pro** | $49/mo | Unlimited quotes, 500 executions/day, priority routing |
| **Enterprise** | Custom | Dedicated infrastructure, SLA, custom integrations |

### 9.3 What do competitors charge?

- **LI.FI API**: Free tier (rate-limited), paid plans for higher throughput. Integrator fee is how THEY monetize you (they take a cut of the fee param).
- **Socket/Bungee**: Similar model. Free API, integrator fees.
- **No MCP bridge aggregator exists yet** — BridgeKitty sets the pricing.

---

## 10. Distribution Strategy

### 10.1 MCP Registries

| Registry | Action | Priority |
|----------|--------|----------|
| **Smithery** (`smithery.ai`) | Publish package | Day 1 |
| **mcp.run** | Register server | Day 1 |
| **Glama MCP directory** | Submit | Week 1 |
| **MCP Hub** | Submit | Week 1 |

### 10.2 Framework Plugins

| Framework | Format | Effort |
|-----------|--------|--------|
| **GOAT SDK** | Plugin wrapping MCP tools → GOAT actions | ~100 LOC wrapper |
| **ElizaOS** | Plugin with actions matching our tools | ~200 LOC |
| **LangChain** | MCP tool adapter (already exists generically) | Config only |
| **Vercel AI SDK** | MCP client support built-in | Config only |

### 10.3 Other Channels

- **npm**: `bridgekitty`
- **Docker**: `ghcr.io/persistence-labs/bridgekitty`
- **llms.txt**: Host at `https://persistence.one/llms.txt` pointing to MCP server docs
- **GitHub**: Open source (MIT) for maximum adoption

---

## 11. Timeline

### Week 1: MVP 🚀

**Deliverable:** Working MCP server with LI.FI + Persistence Interop

- [ ] Project scaffold, CI/CD (Day 1)
- [ ] LI.FI backend adapter — quote, execute, status (Day 1-2)
- [ ] Persistence Interop adapter — port from existing MCP server (Day 2)
- [ ] 3 core tools: `bridge_get_quote`, `bridge_execute`, `bridge_status` (Day 2-3)
- [ ] 2 utility tools: `bridge_chains`, `bridge_tokens` (Day 3)
- [ ] Routing engine with parallel queries (Day 3-4)
- [ ] README, npm publish, Smithery listing (Day 4-5)
- [ ] Demo video with Claude Desktop (Day 5)

**LOC:** ~600  
**Team:** 1 engineer

### Week 2-3: V1

**Deliverable:** Multi-backend aggregation with real route optimization

- [ ] Relay backend adapter (Week 2, Day 1-2)
- [ ] deBridge backend adapter (Week 2, Day 2-3)
- [ ] Across backend adapter (Week 2, Day 3-5)
- [ ] Quote caching + TTL management (Week 3, Day 1)
- [ ] Integration tests against live APIs (Week 3, Day 1-2)
- [ ] GOAT SDK plugin (Week 3, Day 2)
- [ ] ElizaOS plugin (Week 3, Day 3)
- [ ] Error handling hardening, retry logic (Week 3, Day 4-5)

**LOC:** ~1500 total  
**Team:** 1-2 engineers

### Week 4: V1.5

- [ ] `bridge_rebalance` tool (portfolio-aware)
- [ ] `bridge_consolidate` tool (multi-hop)
- [ ] Rate limiting + API key management for paid tiers
- [ ] Monitoring dashboard
- [ ] llms.txt on persistence.one

---

## 12. Dependencies & Infrastructure

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "zod": "^3.x",
    "viem": "^2.x"
  },
  "infrastructure": {
    "hosting": "Runs locally (stdio) or as SSE server on any Node.js host",
    "stateless": "No database needed for MVP. Quote cache is in-memory with TTL.",
    "monitoring": "Optional: Sentry for errors, PostHog for usage analytics"
  }
}
```

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LI.FI API changes/deprecation | High | Abstract behind adapter interface; easy to swap |
| Rate limiting on free tiers | Medium | Cache quotes (60s TTL), batch chain/token lookups |
| Agent signs wrong tx | High | Clear `instructions` field, approval separation, simulation via `eth_estimateGas` |
| Bridge stuck/failed | Medium | Auto-status polling, suggested retry with alternative provider |
| MEV/frontrunning on large bridges | Low | Use private RPCs, slippage protection already in bridge protocols |

---

## 14. Success Metrics

| Metric | Target (Month 1) | Target (Month 3) |
|--------|-------------------|-------------------|
| Smithery installs | 100 | 1,000 |
| Monthly bridge volume | $100K | $1M |
| Monthly revenue (fees) | $300 | $3,000 |
| Unique agents using | 20 | 200 |
| Supported chains | 35+ | 40+ |

---

## 15. Open Questions for Dneorej

1. **Open source?** Recommend MIT for maximum adoption. Revenue comes from integrator fees, not software licensing.
2. **Branding:** BridgeKitty (decided)
3. **API key requirement:** Should we gate behind an API key from Day 1 (for tracking) or keep it fully open?
4. **Signing mode:** Should MVP support delegated signing, or unsigned-only?
5. **Priority on Across integration:** It's the most complex (contract interaction). Worth the effort for V1, or defer?

---

*Spec by Forge ⚒️ — Ready for review. Let's ship this.*
