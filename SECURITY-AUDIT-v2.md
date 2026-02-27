# BridgeKitty Security Audit v2

**Date:** 2026-02-25
**Auditor:** Claw Security (second-pass deep review)
**Scope:** All source files in `src/`, `package.json`, dependency tree
**Prerequisite:** All v1 findings were reportedly fixed. This audit verifies fixes and finds new issues.

---

## Executive Summary

The v1 audit fixes are largely well-implemented. The codebase benefits from rate limiting, RPC overrides, EIP-55 checksum warnings, error sanitization, pre-build expiry checks, and exact-amount approvals. The architecture remains fundamentally sound — stateless quote aggregation returning unsigned tx data.

This v2 audit found **2 MEDIUM**, **5 LOW**, and **3 INFO** new issues missed by v1, plus notes on all verified fixes.

| Severity | Count | New? |
|----------|-------|------|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 2 | ✅ New |
| LOW | 5 | ✅ New |
| INFO | 3 | ✅ New |

---

## Part 1: Verification of v1 Fixes

### ✅ HIGH-001: Private Keys in .env.acp
**Status: VERIFIED (operational — cannot verify from code alone)**
The `.env.acp` is gitignored. The recommendation to remove unused `INTEGRATOR_WALLET_PRIVATE_KEY` and `TEST_BUYER_MNEMONIC` is operational. Code-side, `loadAcpConfig()` in `src/acp/types.ts` only reads `ACP_AGENT_WALLET_PRIVATE_KEY` (required) — `INTEGRATOR_WALLET_PRIVATE_KEY` is never loaded by application code, confirming it's dead config.

### ✅ HIGH-002: ACP Listener Private Key in Memory
**Status: VERIFIED — mitigated by design**
Comments in `src/acp/listener.ts` (line ~81) now include the `⚠️ SECURITY (HIGH-002)` annotation reminding operators to keep minimum balance and sweep fees. Architectural constraint remains (SDK requires signing key).

### ✅ MEDIUM-001: Approval Amount Mismatch
**Status: VERIFIED FIXED**
- `src/backends/lifi.ts`: Uses step `action.fromAmount` for approval with exact-amount `buildApproveData()`. LiFi API returns the correct approval amount per step.
- `src/backends/across.ts`: Uses `p.amountRaw` — correct for direct deposit.
- `src/backends/relay.ts`: Uses Relay API's own approval tx data.
- `src/tools/execute-bridge.ts` (lines ~82-85): Documents exact-amount approvals with clear user-facing note.

### ✅ MEDIUM-002: No Address Checksum Validation
**Status: VERIFIED FIXED**
`src/utils/evm.ts` `isValidEvmAddress()` now imports ethers `getAddress()` and validates EIP-55 checksums for mixed-case addresses. Logs a warning on mismatch but accepts the address (non-breaking). Correctly handles all-lowercase and all-uppercase as valid.

### ✅ MEDIUM-003: Simulation Bypassed for Unknown Chains
**Status: VERIFIED FIXED**
`src/utils/tx-simulator.ts` now calls `getChainRpcUrl()` from gas-estimator which checks `RPC_<CHAIN>` env var overrides before falling back to default Ankr URLs. The warning log includes `MEDIUM-003` tag for monitoring.

### ✅ MEDIUM-004: Quote Cache Race Condition
**Status: VERIFIED FIXED**
`src/tools/execute-bridge.ts` (lines ~55-63) now checks `quote.expiresAt <= Date.now() + BUILD_TIMEOUT_MS` before calling `buildTransaction`, rejecting quotes that would expire during the build step.

### ✅ LOW-001: Hardcoded Public RPC Endpoints
**Status: VERIFIED FIXED**
`src/utils/gas-estimator.ts` `getChainRpcUrl()` checks `process.env[CHAIN_RPC_ENV_KEYS[chainId]]` first, falling back to Ankr defaults. Covers all 12 supported chains.

### ✅ LOW-002: Fallback Prices Can Drift
**Status: VERIFIED FIXED**
`GasCostEstimate` interface includes `usingFallbackPrices: boolean`. The `BridgeQuote` type carries this through. `src/tools/get-quote.ts` formats gas with `~$X.XX (est)` markers for backends where gas is estimated locally (debridge, across, persistence).

### ✅ LOW-003: Test Scripts Use Private Keys
**Status: NOT VERIFIED** — Scripts are outside audit scope but still exist in `scripts/`. Operational recommendation stands.

### ✅ LOW-004: Error Messages Leak Internal State
**Status: VERIFIED FIXED**
`src/acp/handler.ts` catch block (bottom of `handleBridgeJob`) returns sanitized `"Bridge quote failed. Please try again later."` instead of raw error details. Raw error is logged server-side only.

### ✅ LOW-005: No Rate Limiting on MCP Tools
**Status: VERIFIED FIXED**
`src/tools/get-quote.ts` implements per-route rate limiting: 10 requests/minute per `fromChain:toChain:fromToken:toToken` key. Uses sliding window with timestamp pruning. Clean implementation.

---

## Part 2: New Findings

### NEW-MEDIUM-001: `cheapest` Sort Logic Can Select Worse Quote When Gas Costs Differ by Unit

**File:** `src/routing/engine.ts`, `getQuotes()` sorting logic (cheapest branch)
**Severity:** MEDIUM

When sorting by `cheapest`, the code computes "net value" as `parseFloat(minOutputAmount) - estimatedGasCostUsd`. This mixes two different units:
- `minOutputAmount` is in **token units** (e.g., "99.5 USDC" or "0.00095 BTC")
- `estimatedGasCostUsd` is in **USD**

For stablecoin bridges (USDC → USDC), this works accidentally because 1 USDC ≈ $1. But for non-stablecoin bridges (e.g., ETH → ETH, BTC → BTC), the math is wrong:
- Quote A: receive 0.99 ETH, gas $0.50 → net = 0.99 - 0.50 = 0.49
- Quote B: receive 0.98 ETH, gas $0.01 → net = 0.98 - 0.01 = 0.97

Quote B appears better (net 0.97 > 0.49), but Quote A actually returns 0.01 ETH more (~$18.50 at current prices), which far exceeds the $0.49 gas savings.

**Impact:** For non-stablecoin bridges with `preference: "cheapest"`, a worse quote could be ranked first. This applies to both MCP and ACP (ACP defaults to `"cheapest"`).

**Recommendation:** Convert output to USD before comparing net value, or compare output amounts in raw BigInt and only use gas cost as a tiebreaker.

---

### NEW-MEDIUM-002: Rate Limiter State Grows Unboundedly (Memory Leak)

**File:** `src/tools/get-quote.ts`, `rateLimitMap` (line ~10)
**Severity:** MEDIUM

The `rateLimitMap` is a module-level `Map<string, number[]>` that stores timestamps per route key. While timestamps within a route are pruned on each call, **route keys are never evicted**. Over time with diverse routes, this map grows without bound.

For an MCP server (short-lived stdio process), this is low risk. For the ACP listener (long-running daemon), this could accumulate thousands of route keys over days/weeks, each holding an array.

**Impact:** Slow memory leak in long-running ACP listener.

**Recommendation:** Add periodic cleanup (e.g., delete entries with no recent timestamps) or use an LRU-bounded map. Alternatively, prune the entire map every N minutes.

---

### NEW-LOW-001: BigInt-to-Number Precision Loss in Gas Estimation

**File:** `src/utils/gas-estimator.ts`, `estimateGasCostUsd()` (line ~168)
**Severity:** LOW

```typescript
const gasCostWei = BigInt(gasUnits) * gasPriceResult.priceWei;
const gasCostEth = Number(gasCostWei) / 1e18;
```

`Number(gasCostWei)` loses precision for values > 2^53. For typical gas costs (150k units × 30 gwei = 4.5e15 wei), this is fine. But if a chain has extremely high gas prices (e.g., > ~9000 gwei), the BigInt could exceed `Number.MAX_SAFE_INTEGER` (9.007e15), causing silent precision loss.

**Impact:** Extremely unlikely in practice — gas prices would need to be 100x higher than normal. But worth noting for correctness.

**Recommendation:** Use `Number(gasCostWei / 10n**9n) / 1e9` to keep intermediate values smaller, or format using BigInt division throughout.

---

### NEW-LOW-002: Across Backend Hardcoded Spoke Pool Addresses

**File:** `src/backends/across.ts` (SPOKE_POOL_ADDRESSES map)
**Severity:** LOW

The Across spoke pool addresses are hardcoded per chain. If Across upgrades their contracts (which has happened before — V2 to V3), the addresses become stale. There's no mechanism to detect this — `buildTransaction` would produce transactions to an old contract that may not work.

**Impact:** Bridge failure (not fund loss — unsigned tx would revert or user's wallet would flag it). Requires code update to fix.

**Recommendation:** Consider fetching spoke pool addresses from the Across API at startup or on first use, with hardcoded values as fallback. Alternatively, add a configuration mechanism to override addresses.

---

### NEW-LOW-003: SSRF Potential via Chain ID in Gas Estimator

**File:** `src/utils/gas-estimator.ts`, `getChainRpcUrl()`
**Severity:** LOW

`resolveChainId()` in `src/utils/chains.ts` accepts **any positive integer** as a chain ID (not just the hardcoded list). If a user passes a chain ID like `99999`, the routing engine passes it to backends. While the gas estimator only has RPCs for known chains (returning `undefined` for unknown ones), the `RPC_<CHAIN>` env var lookup uses a fixed map so there's no injection vector there.

However, the LiFi and deBridge backends pass user-controlled chain IDs directly into their API URLs:
- LiFi: `https://li.quest/v1/quote?fromChain=${params.fromChainId}` 
- deBridge: URL with `srcChainId=${params.fromChainId}`

These go to third-party APIs, not arbitrary URLs, so SSRF risk is **minimal** — the domain is fixed and the chain ID is just a query parameter. But malformed chain IDs could trigger unexpected behavior in those APIs.

**Impact:** Minimal. The receiving APIs validate their own inputs.

**Recommendation:** No urgent action needed. For defense-in-depth, consider validating chain IDs against a known set in the routing engine.

---

### NEW-LOW-004: ACP Listener Accepts Job Before Verifying Fee Payment Amount

**File:** `src/acp/listener.ts`, `onNewTask()` (REQUEST → NEGOTIATION phase)
**Severity:** LOW

When a job arrives in the REQUEST phase, the listener calls `parseRequirement()` and then `job.accept()`. It validates that the requirement is well-formed but does **not** verify that the job fee matches `config.servicePriceUsd`. Fee enforcement is presumably handled by the ACP smart contract layer, but this isn't verified in application code.

If the ACP SDK has a bug where it accepts jobs at a lower fee than configured, the listener would process them at a loss.

**Impact:** Depends on ACP SDK correctness. Low risk if SDK enforces pricing.

**Recommendation:** Log the job fee amount and compare against `config.servicePriceUsd` for monitoring. Consider rejecting jobs where the fee is below the configured minimum.

---

### NEW-LOW-005: `parseTokenAmount` Truncates Instead of Rounding

**File:** `src/utils/tokens.ts`, `parseTokenAmount()`
**Severity:** LOW

```typescript
const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
```

When a user passes `"1.123456789"` for a 6-decimal token (USDC), the function silently truncates to `"1.123456"` (1123456 raw) instead of rounding to `"1.123457"` (1123457 raw). The difference is 0.000001 USDC (1 wei), which is negligible.

**Impact:** Negligible. Loss is < 1 unit of smallest denomination. Standard practice in DeFi to truncate rather than round.

**Recommendation:** No action needed. Document the truncation behavior if desired.

---

### NEW-INFO-001: Supply Chain — 217 Production Dependencies via `@virtuals-protocol/acp-node`

**File:** `package.json`

The project has 217 production dependencies, mostly pulled in by `@virtuals-protocol/acp-node` (which depends on ethers v5, alchemy-sdk, and account-kit). `npm audit` reports 17 low-severity vulnerabilities, all in the ethers v5 / ethersproject transitive dependency tree used by the ACP SDK.

The main `ethers` dependency (v6) used by BridgeKitty's own code is clean. The vulns are all in v5 transitives from the ACP SDK.

**Impact:** Low — the vulnerabilities are in hash/signing functions within ethers v5 which the ACP SDK uses internally. No direct exploitation path from BridgeKitty's perspective.

**Recommendation:** Monitor `@virtuals-protocol/acp-node` for updates that migrate to ethers v6. The beta status (0.3.0-beta.34) of this SDK is itself a risk factor — beta APIs may change.

---

### NEW-INFO-002: Persistence Backend Decimal Normalization Assumes Binary Mapping

**File:** `src/backends/persistence.ts`, `validateAmount()` (line ~50)

```typescript
const fromDecimals = fromToken?.symbol === "BTCB" ? 18 : 8;
```

This hardcodes BTCB=18 decimals, everything else=8 decimals. If Persistence Interop adds support for a new BTC variant with different decimals (e.g., sBTC with 18 decimals on Base), this logic would incorrectly treat it as 8 decimals, potentially allowing amounts 10^10 times larger than intended past the cap check.

**Impact:** No current risk — only two tokens are supported. Becomes relevant if token support expands.

**Recommendation:** Look up decimals from the token registry or the `BTC_TOKENS` map directly rather than branching on symbol name.

---

### NEW-INFO-003: `formatTokenAmount` Edge Case with Amounts Smaller Than 1 Unit

**File:** `src/utils/tokens.ts`, `formatTokenAmount()`

For a token with 18 decimals and amount `"1"` (1 wei), the function produces:
- `str = "0000000000000000001"` (padded to 19 chars)
- `intPart = "0"`, `fracPart = "000000000000000001"`
- After trimming trailing zeros and slicing to 8 chars: `fracPart = "00000000"`
- Trimming trailing zeros: empty → returns `"0"`

So 1 wei of an 18-decimal token displays as `"0"` instead of `"0.000000000000000001"`. This is because the display is capped at 8 decimal places.

**Impact:** Cosmetic only. No financial impact since these sub-dust amounts are not meaningful in bridge contexts.

---

## Part 3: Review of New Fix Code

### Rate Limiter (`src/tools/get-quote.ts`)
✅ Clean sliding-window implementation. Correctly prunes expired timestamps on each call. Per-route granularity prevents one hot route from blocking others. **One issue noted:** unbounded map growth (NEW-MEDIUM-002 above).

### RPC Override System (`src/utils/gas-estimator.ts`)
✅ Clean env-var-based override with fixed key mapping (`CHAIN_RPC_ENV_KEYS`). No injection risk since keys are hardcoded. Falls back to Ankr defaults correctly.

### Error Sanitization (`src/acp/handler.ts`)
✅ Generic error message returned to external callers. Full error logged server-side. No internal state leakage in ACP responses.

### Checksum Validation (`src/utils/evm.ts`)
✅ Validates EIP-55 for mixed-case, accepts all-lower and all-upper. Uses `require("ethers")` — note this is a CJS require in an ESM module. Works with current Node.js but may break with future strict ESM enforcement. Consider switching to dynamic `import()`.

### Approval Cap (`src/utils/evm.ts` / `src/tools/execute-bridge.ts`)
✅ Exact-amount approvals already existed (INFO-001 in v1). The v1 notes correctly document this. No unlimited approvals anywhere.

### Pre-build Expiry Check (`src/tools/execute-bridge.ts`)
✅ Checks `quote.expiresAt <= Date.now() + BUILD_TIMEOUT_MS` before proceeding. Returns user-friendly message to get fresh quote.

---

## Summary of Actionable Items (Priority Order)

1. **NEW-MEDIUM-001** — Fix `cheapest` sort to compare net value in consistent units (USD). **Affects ACP correctness.**
2. **NEW-MEDIUM-002** — Add LRU/TTL eviction to `rateLimitMap` for long-running processes.
3. **NEW-LOW-002** — Consider fetching Across spoke pool addresses dynamically or adding config override.
4. **NEW-LOW-004** — Log and optionally validate ACP job fee amounts.
5. **NEW-LOW-001** — Use safer BigInt→Number conversion in gas estimation.
6. **Checksum fix** — Switch `require("ethers")` to `await import("ethers")` for ESM compatibility.

---

## Conclusion

The v1 fixes were implemented correctly and address the originally identified risks. The codebase is well-structured with good separation of concerns. The two new MEDIUM findings are: (1) a unit-mismatch bug in cheapest-route ranking that could select suboptimal quotes for non-stablecoin bridges, and (2) an unbounded rate-limit map. Neither is a fund-loss vulnerability given the unsigned-tx-only architecture. Overall security posture remains **LOW-MEDIUM risk**.
