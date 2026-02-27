# BridgeKitty ACP Integration — Technical Spec

**Date:** 2026-02-24
**Status:** DRAFT
**Author:** Claw (Chief of Staff)

---

## 1. Overview

Integrate BridgeKitty as a **seller agent** on Virtuals Protocol's Agent Commerce Protocol (ACP). Any agent on ACP can hire BridgeKitty to get cross-chain bridge quotes and transaction data.

**What we deliver:** Unsigned transaction data (quote + calldata). The buyer agent handles signing and submission. BridgeKitty never touches user funds.

---

## 2. Wallet Architecture

### Two separate wallets (CRITICAL — never mix these):

**Wallet 1: ACP Service Wallet**
- Purpose: Receives the flat $0.20 per-job service fee from ACP escrow
- Funded with: USDC / $VIRTUAL from ACP job payments
- Chain: Base (where ACP settles)
- Label: `bridgekitty-acp-service`

**Wallet 2: Integrator Fee Wallet**
- Purpose: Receives integrator/referral fees from bridge backends (LI.FI, Relay, deBridge)
- These are % fees on bridge volume, collected by the bridge protocols and paid to us
- Could be on multiple chains depending on the backend
- Label: `bridgekitty-integrator-fees`

Both wallets must be freshly generated for this project. Do NOT reuse existing wallets.

---

## 3. ACP Service Registration

### Offering: `bridgekitty-bridge`

**Price:** $0.20 USD per job (flat fee)

**Requirements Schema:**
```json
{
  "fromChain": "string — chain name or ID (e.g. 'ethereum', '1', 'bsc', '56')",
  "toChain": "string — destination chain name or ID",
  "fromToken": "string — token symbol (e.g. 'USDC') or contract address",
  "toToken": "string — destination token symbol or contract address",
  "amount": "string — human-readable amount (e.g. '100' for 100 USDC)",
  "senderAddress": "string — the address that will sign and send the tx",
  "recipientAddress": "string (optional) — destination address, defaults to senderAddress"
}
```

**Deliverable Schema:**
```json
{
  "status": "success | no_routes | error",
  "quote": {
    "provider": "string",
    "youReceiveMin": "string — e.g. '99.85 USDC'",
    "estimatedGasFee": "string — e.g. '$0.05' or '~$0.12 (est)'",
    "estimatedTime": "string — e.g. '4s'",
    "route": "string — e.g. 'USDC → Relay → USDC'",
    "quoteId": "string — for execution"
  },
  "transaction": {
    "to": "string — contract address to call",
    "data": "string — calldata (hex)",
    "value": "string — ETH value to send (usually '0')",
    "chainId": "number — source chain",
    "gasLimit": "string (optional)"
  },
  "approvalTx": {
    "to": "string — token contract",
    "data": "string — approve calldata",
    "value": "0",
    "chainId": "number"
  },
  "instructions": "string — human-readable steps for the agent",
  "warnings": ["string — any security notes, e.g. 'This requires a token approval'"]
}
```

---

## 4. Job Handler Flow

When BridgeKitty receives a job from ACP:

```
1. Parse job params (fromChain, toChain, fromToken, toToken, amount, senderAddress)
2. Validate inputs (same validation as MCP tools)
3. Call routing engine → getQuotes(params)
4. If no routes → submit deliverable with status: "no_routes"
5. Pick best quote (highest net value)
6. Call buildTransaction(bestQuote) → get tx data
7. If tx simulation fails → submit deliverable with status: "error" + reason
8. Submit deliverable with quote + transaction data
```

**Timeout:** 30s max per job. If we can't deliver in 30s, submit error.

---

## 5. Integrator Fee Setup

Configure bridge backends to collect referral/integrator fees:

- **LI.FI:** Set `LIFI_INTEGRATOR` and `LIFI_FEE` env vars → fees go to integrator wallet. Requires registration at portal.li.fi.
- **Relay:** Set `RELAY_REFERRER_ADDRESS` → referral fees.
- **deBridge:** Set `DEBRIDGE_AFFILIATE_FEE` and `DEBRIDGE_AFFILIATE_ADDRESS`.
- **Across:** Check if they have a referral program.
- **Persistence:** Our own protocol — no integrator fee needed (we ARE the protocol).

These are SEPARATE from the ACP $0.20 job fee. These are % on volume.

---

## 6. Architecture

```
                    ACP (Base)
                       │
                  WebSocket
                       │
              ┌────────┴────────┐
              │  ACP Wrapper     │  ← new code (~200-300 LOC)
              │  (job listener,  │
              │   deliverable    │
              │   submission)    │
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  BridgeKitty     │  ← existing routing engine
              │  Routing Engine  │
              └────────┬────────┘
                       │
        ┌──────┬───────┼───────┬──────┐
        │      │       │       │      │
      LI.FI  deBridge Across  Relay  Persistence
```

**The ACP wrapper is a thin layer** that:
- Connects to ACP via WebSocket
- Listens for incoming jobs
- Translates ACP job params → BridgeKitty routing engine calls
- Translates BridgeKitty results → ACP deliverables
- Submits deliverables back to ACP

---

## 7. File Structure

```
src/
  acp/
    listener.ts      — WebSocket connection to ACP, job event handling
    handler.ts       — Job processing logic (params → routing → deliverable)
    registration.ts  — Service offering registration
    types.ts         — ACP-specific types
  backends/          — existing
  routing/           — existing
  tools/             — existing MCP tools
  utils/             — existing
```

---

## 8. Environment Variables

```env
# ACP Configuration
ACP_AGENT_WALLET_PRIVATE_KEY=    # Wallet 1: receives $0.20 per job
ACP_SERVICE_PRICE_USD=0.20       # Flat fee per job
ACP_AGENT_ID=                    # Our agent ID on Virtuals

# Integrator Fee Wallet
INTEGRATOR_WALLET_ADDRESS=       # Wallet 2: receives % fees from backends

# Backend Integrator Fees (existing, point to Wallet 2)
LIFI_INTEGRATOR=bridgekitty
LIFI_FEE=0.003                   # 0.3% integrator fee
RELAY_REFERRER_ADDRESS=          # = INTEGRATOR_WALLET_ADDRESS
DEBRIDGE_AFFILIATE_FEE=30        # 0.3% in basis points
DEBRIDGE_AFFILIATE_ADDRESS=      # = INTEGRATOR_WALLET_ADDRESS
```

---

## 9. Security

- ACP wallet private key MUST be in env var, never hardcoded
- Integrator wallet is address-only (no private key needed — backends pay to it)
- BridgeKitty never holds or transfers user funds
- All transaction data is unsigned — buyer agent signs with their own key
- Rate limit job acceptance (max 10 concurrent jobs)

---

## 10. Testing

1. Register service on ACP testnet (if available) or mainnet with low fee
2. Create a test buyer agent that sends a bridge job
3. Verify: job received → quote generated → deliverable submitted → payment received
4. Test error cases: invalid params, no routes, backend timeout

---

## 11. Launch Sequence

1. Generate Wallet 1 (ACP service) and Wallet 2 (integrator fees)
2. Register on LI.FI portal for integrator ID
3. Build ACP wrapper
4. Test locally (mock ACP or testnet)
5. Register service on ACP mainnet
6. Monitor first jobs
