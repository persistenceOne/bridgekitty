# BridgeKitty Screen Recording Plan

> **Purpose:** Twitter marketing push showcasing BridgeKitty's ease of use and adoption.
> **Format:** Quick screen recordings, no audio/voiceover needed. Clean slate — show everything from a fresh start.
> **Deadline:** Recordings needed for Promet to edit and publish.

---

## Recording Guidelines

- Start from a completely clean environment (no pre-existing config)
- Show the full flow: install → configure → interact → execute
- Keep each recording focused on one scenario
- Let the AI agent's responses be clearly visible on screen

---

## Part A — Required Scenarios (from Standup)

> These are the scenarios Jeroen requested. Each recording should show installing the MCP server via Cursor or Claude and going all the way through to executing a transaction.

### 1. Basic Bridging — Get Quote & Execute (cbBTC → BTCB)

**What to show:** Getting a quote and making a transaction to bridge assets.

- Install BridgeKitty in Cursor/Claude (clean start)
- Ask the agent to get a quote for bridging cbBTC (Base) → BTCB (BSC)
- Show the multi-provider quote comparison (output amount, fees, estimated time)
- Execute the bridge transaction
- **Why:** Core use case — the simplest happy path, shows the product end-to-end
- **Prompt:** 
- 1. Get a quote to bridge $10 of cbBTC from Base to BTCB on BNB Chain. Show me my current balances on both chains, and display a multi-provider quote comparison with output amounts, fees, and estimated times so I can approve the transaction in bridgekitty MCP Server.
- 2. Install the BridgeKitty MCP server by running claude mcp add bridgekitty -- npx -y @persistenceone/bridgekitty in the terminal, then restart Claude Code and verify with claude mcp list that it shows connected.


---

### 2. Persistence Bridge — XPRT Farming

**What to show:** How to participate in XPRT farming via Persistence Interop.

- Use `xprt_onboard` to get a personalized onboarding plan
- Run `xprt_farm_prepare` to set up prerequisites
- Start farming with `xprt_farm_start` (use `dryRun=true` for safety)
- Check rewards with `xprt_rewards_check`
- **Why:** The sticky differentiator — earn XPRT by bridging BTC variants

---

### 3. Cross-Chain EVM to EVM Bridging

**What to show:** Bridging between two EVM chains (e.g., USDC from Ethereum → Arbitrum, or ETH from Base → Optimism).

- Get a quote, show provider comparison
- Execute with `sign_and_send=true` for full autonomous flow
- Track with `bridge_status` until complete
- **Why:** Bread-and-butter cross-chain use case

---

### 4. EVM to Solana Bridging

**What to show:** Bridging from an EVM chain to Solana (e.g., USDC from Ethereum → Solana via deBridge).

- Ask the agent to bridge to Solana
- Show deBridge handling the cross-ecosystem route
- Track the transaction status
- **Why:** Demonstrates ecosystem breadth beyond EVM-only

---

## Part B — Additional Suggested Scenarios

> These additional recordings round out the story by showcasing setup ease, aggregation intelligence, AI-native UX, and the full autonomous agent loop.

### 5. Zero-Install Setup via `npx`

**What to show:** Adding BridgeKitty to Cursor (or Claude Desktop) MCP config and running it for the first time.

- Open Cursor settings / Claude config
- Paste the MCP server JSON config:
  ```json
  {
    "bridgekitty": {
      "command": "npx",
      "args": ["@persistenceone/bridgekitty"]
    }
  }
  ```
- Show the server starting up and tools becoming available
- **Why:** First impression — demonstrates the zero-install, copy-paste setup story
- **Prompt:** Install the @persistenceone/bridgekitty package using npm i. Once installed, add the bridgekitty MCP server to my configuration using the command npx with the argument @persistenceone/bridgekitty. Verify the connection once it's added.
---

### 6. Wallet Setup (One Mnemonic → Three Ecosystems)

**What to show:** `wallet_setup` creating EVM + Cosmos + Solana wallets from a single mnemonic, then `wallet_balance` showing balances with USD valuations.

- Ask the agent to set up a wallet
- Show all three ecosystem addresses generated
- Check balances across multiple chains
- **Why:** "One command, three ecosystems" wow moment

---

### 7. Multi-Provider Quote Comparison

**What to show:** `bridge_get_quote` querying all 6 backends in parallel and returning ranked results.

- Ask for a quote on a popular route (e.g., USDC Base → USDC Arbitrum)
- Highlight: best quote, alternatives, fee breakdowns, failed providers
- Show how the agent explains which provider wins and why
- **Why:** The "1inch for bridges" pitch — aggregation intelligence in action

---

### 8. XPRT Staking & Multiplier Boost

**What to show:** `xprt_farm_boost` — buying XPRT via bridge and auto-staking for a higher reward multiplier.

- Check current multiplier tier (1x)
- Use `xprt_farm_boost` with `dryRun=true` to preview the boost
- Show the 1x → 2x or 5x multiplier upgrade path
- **Why:** Shows the reward acceleration mechanic that keeps users engaged

---

### 9. EVM to Cosmos Bridging

**What to show:** Using Squid Router to bridge from an EVM chain to a Cosmos chain (e.g., Base → Persistence chain).

- Ask the agent to bridge assets to Cosmos/Persistence
- Show Squid Router handling the cross-ecosystem route
- **Why:** Three-ecosystem story — EVM, Solana, AND Cosmos from one tool

---

### 10. Multi-Hop Routing

**What to show:** `bridge_quote_multi` for a complex route no single bridge handles natively.

- Ask to bridge something like ETH on Ethereum → USDC on Arbitrum via an intermediate token
- Show the agent breaking it into hops and finding the optimal path
- **Why:** Power feature — the routing engine solves routes humans wouldn't think of

---

### 11. Sign-and-Send — Full Autonomous Agent Flow

**What to show:** `bridge_execute` with `sign_and_send=true` — the agent gets a quote, signs, broadcasts, and tracks the transaction.

- Ask the agent to bridge and execute in one go
- Show the full lifecycle: quote → approve → sign → broadcast → track → complete
- **Why:** Flagship demo — AI agent executing a real cross-chain transfer autonomously

---

### 12. Transaction Status Tracking

**What to show:** `bridge_status` tracking a cross-chain transfer in real-time.

- After any executed bridge, ask the agent to check status
- Show the pending → completed progression
- **Why:** Demonstrates the full transaction lifecycle (can be appended to any bridge recording)

---

### 13. `xprt_onboard` — Personalized Onboarding

**What to show:** The agent generating a step-by-step plan based on the wallet's current state.

- Run `xprt_onboard` with a wallet that has some balances
- Show the agent reading wallet state and recommending next steps
- **Why:** AI-native UX — the agent tells you what to do, not the other way around

---

### 14. `bridgekitty_help` — Agent Self-Discovery

**What to show:** The AI agent calling `bridgekitty_help` to learn about BridgeKitty on its own.

- Ask the agent "what can you do with bridges?" or similar
- Show it calling the help tool and explaining capabilities
- **Why:** Zero learning curve — the agent discovers the tool's features by itself

---

## Suggested Recording Order

| # | Scenario | Source | Priority | Est. Length |
|---|----------|--------|----------|-------------|
| 1 | Basic Bridging (cbBTC → BTCB) | Standup | Must have | 60–90s |
| 2 | XPRT Farming (Persistence Bridge) | Standup | Must have | 90–120s |
| 3 | Cross-Chain EVM → EVM | Standup | Must have | 60–90s |
| 4 | EVM → Solana | Standup | Must have | 60–90s |
| 5 | Zero-Install Setup | Additional | Must have | 30–60s |
| 6 | Wallet Setup | Additional | Must have | 30–45s |
| 7 | Multi-Provider Comparison | Additional | Must have | 45–60s |
| 11 | Sign-and-Send Autonomous Flow | Additional | Must have | 60–90s |
| 8 | XPRT Staking & Boost | Additional | High | 45–60s |
| 13 | Personalized Onboarding | Additional | High | 30–45s |
| 9 | EVM → Cosmos | Additional | Medium | 60s |
| 10 | Multi-Hop Routing | Additional | Medium | 45–60s |
| 12 | Transaction Tracking | Additional | Nice to have | 30s |
| 14 | Agent Self-Discovery | Additional | Nice to have | 20–30s |

---

## Notes for Promet (Editor)

- Scenarios 1–4 are the priority recordings from the standup — get these done first
- Scenarios 5 + 6 can be stitched into a single "Getting Started" clip
- Scenarios 1, 3, 4 showcase the three bridging directions (BTC variants, EVM↔EVM, EVM→Solana)
- Scenario 11 is the hero clip — full autonomous agent bridging
- Speed up any waiting/loading portions in post
- Add captions/callouts highlighting key moments (quote comparison, tx confirmation, etc.)
