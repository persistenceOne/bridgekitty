# BridgeKitty Hardening Plan

**Author:** Forge ⚒️  
**Date:** 2026-02-24  
**Status:** IN PROGRESS

---

## Architecture Overview

BridgeKitty is an MCP server with 5 tools, 5 backend adapters, and a routing engine:

```
Tool Layer (get-quote, execute-bridge, check-status, get-chains, get-tokens)
    → Routing Engine (parallel queries, sorting, caching)
        → Backend Adapters (lifi, debridge, across, relay, persistence)
```

Quotes flow: Tool → Engine → All backends in parallel → Filter/sort → Cache with UUID → Return to agent.
Execution flow: Tool → Engine cache lookup → Backend `buildTransaction()` → Return unsigned TX.

---

## 🔴 Critical Bugs Found

### CRIT-001: Execute bridge can never find backend
`execute-bridge.ts` calls `engine.getBackend(quote.provider)` but `quote.provider` is a human-readable string like `"Stargate via LI.FI"` while backend names are `"lifi"`, `"debridge"`, etc. **The execute tool is completely broken** — it will always return "Backend not available."

**Fix:** Add a `backendName` field to `BridgeQuote` to store the machine-readable backend name. Use that for lookup.

### CRIT-002: Across fee calculation is wrong  
`feeUsd = Number(data.totalRelayFee.total) / Math.pow(10, decimals)` — this gives the fee in TOKEN units (e.g. 0.5 USDC), not USD. For stablecoins it's close, but for ETH/WBTC it's completely wrong.

**Fix:** Across doesn't provide USD fee estimates. We should label this as token-denominated and handle the conversion better, or mark estimatedFeeUsd as 0 with a note.

---

## 🟡 Routing Layer Issues

### ROUTE-001: No input validation before backend calls
No validation of: positive amounts, valid EVM addresses, non-zero chain IDs. Invalid inputs go straight to backend APIs.

**Fix:** Add `validateQuoteParams()` in routing engine that throws a generic `ValidationError` before any backend call.

### ROUTE-002: No expired quote filtering at routing level
Only Persistence filters expired quotes. Other backends hardcode `expiresAt: Date.now() + 60_000` so it's less critical now, but when real expiry times are available, expired quotes could be returned.

**Fix:** Filter `quote.expiresAt <= Date.now()` in the routing engine after collecting all quotes.

### ROUTE-003: PersistenceValidationError leaks into routing
The routing engine imports and checks for a backend-specific error type. This couples the engine to a specific backend.

**Fix:** Create a generic `BackendValidationError` in `types.ts`. Persistence re-exports or extends it.

### ROUTE-004: Timeout mismatch
Routing engine has 5s timeout, but backends have 15s internal timeouts. The 5s routing timeout wins, so backend timeouts are effectively unused for quote calls.

**Fix:** Keep 5s routing timeout (it's better for UX) but document the behavior. Reduce backend-level timeout to match.

---

## 🟡 Backend Issues

### LI.FI (`lifi.ts`)
- ✅ Multi-route via `/advanced/routes` — good
- ✅ Error handling catches and returns `[]` — good
- ⚠️ Hardcoded `expiresAt: Date.now() + 60_000` — not from API
- ⚠️ `buildApproveData` duplicated across all backends
- ⚠️ No validation of response shape before deep property access

### deBridge (`debridge.ts`)
- ✅ Uses `getBackendChainId()` for Solana mapping — good
- ⚠️ `costsDetails?.reduce(...)` — null-safe but `Number(c.payload?.feeApproximateUsdValue ?? 0)` could be NaN
- ⚠️ Only returns single quote (no `getQuotes()` method)
- ⚠️ `buildTransaction` doesn't validate `data.tx` shape

### Across (`across.ts`)
- ✅ Correctly skips cross-token routes — good
- 🔴 Fee calculation wrong (see CRIT-002)
- ⚠️ `depositV3` selector may be incorrect (`0xe7a050aa` looks wrong)
- ⚠️ Hardcoded `SPOKE_POOLS` can go stale
- ⚠️ Only returns single quote

### Relay (`relay.ts`)
- ⚠️ Uses `POST /quote` — spec says `/quote/v2` (may be fine if v1 redirects)
- ⚠️ `buildTransaction` step/item iteration is fragile
- ⚠️ `getStatus` uses `/intents/status/v2` — spec says `v3`
- ⚠️ Only returns single quote

### Persistence (`persistence.ts`)
- ✅ Amount validation with min/max caps
- ✅ Expired quote filtering
- ✅ Descriptive error messages
- ⚠️ `PersistenceValidationError` should become generic `BackendValidationError`
- ⚠️ `_meta` field added outside type definition

---

## 🟡 Tool Layer Issues

### get-quote.ts
- ⚠️ Amount validation uses `Number()` which loses precision for large values
- ⚠️ Validation happens AFTER `parseTokenAmount` which could throw first
- ⚠️ Imports `PersistenceValidationError` directly

### execute-bridge.ts
- 🔴 See CRIT-001: `getBackend(quote.provider)` always fails
- ⚠️ No re-validation of quote freshness before building tx

### check-status.ts
- ⚠️ Defaults to "lifi" when no provider specified — arbitrary

---

## Phase 2 Implementation Order

1. **Shared utilities**: Extract `buildApproveData` into `utils/evm.ts`, create `BackendValidationError` in `types.ts`
2. **BridgeQuote type update**: Add `backendName` field
3. **Routing engine hardening**: Input validation, expired quote filtering, generic error handling
4. **Backend fixes**: All 5 backends updated for consistency
5. **Tool layer fixes**: Fix execute-bridge backend lookup, improve validation ordering
6. **Test suite**: Comprehensive tests for all layers

---
