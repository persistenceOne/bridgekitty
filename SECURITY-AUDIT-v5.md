# BridgeKitty Security Audit v5

**Date:** 2026-02-25
**Auditor:** Claw (automated)
**Scope:** Full codebase (`src/`, `scripts/`), with focus on new Persistence EIP-712 flow
**Previous audit:** v4

---

## Executive Summary

The Persistence backend rewrite introduces a well-structured EIP-712 Permit2 witness signing flow. The implementation is largely correct but has **2 HIGH**, **3 MEDIUM**, and **4 LOW** findings. Several v4 findings have been properly addressed. The codebase quality has improved significantly since v4.

---

## Priority 1: Persistence EIP-712 Flow (NEW CODE)

### HIGH-001: Permit2 Nonce Reuse Window After Failed `initiate()`

**File:** `src/backends/persistence.ts` — `signAndExecute()` lines ~380-410
**Severity:** HIGH

In `signAndExecute()`, after the EIP-712 signature is created (Step 3), if `settlement.initiate()` reverts (Step 4), the Permit2 nonce has been used in the signature but NOT consumed on-chain. The signature remains valid and could be replayed by anyone who observed the failed transaction's calldata in the mempool.

**Attack scenario:**
1. User calls `signAndExecute()`, approval succeeds, signature is created
2. `initiate()` reverts (e.g., deadline passed, insufficient solver liquidity)
3. The signed Permit2 message with that nonce is now visible in the failed tx calldata on-chain
4. An attacker extracts the signature and order data from the failed tx
5. Attacker calls `initiate()` with the same order+signature before the Permit2 nonce is invalidated
6. Funds are pulled from the user at the original order terms (which may now be unfavorable)

**Mitigation:** After a failed `initiate()`, explicitly invalidate the Permit2 nonce by calling `permit2.invalidateUnorderedNonces()` or warn the user to revoke the Permit2 allowance. Alternatively, use a very tight `initiateDeadline` (e.g., 5 minutes instead of 1 hour).

**Note:** The 1-hour `initiateDeadline` (line ~270) is generous. A tighter deadline (5-10 min) would reduce the replay window substantially.

### HIGH-002: Approval Persists After Failed Execution

**File:** `src/backends/persistence.ts` — `signAndExecute()` lines ~370-380
**Severity:** HIGH

If `initiate()` reverts after the ERC20 approval to Permit2 succeeds, the approval remains active. Combined with HIGH-001, this means the Permit2 contract retains allowance to pull the user's tokens. Even without HIGH-001, the lingering approval is a risk if the Permit2 contract or settlement contract has a vulnerability.

The approval amount is exact (good — not unlimited), but it persists indefinitely until used or revoked.

**Mitigation:** On `initiate()` failure, reset the Permit2 approval to 0. Add a `try/catch` around `initiate()` that revokes on failure.

### MEDIUM-001: `prepareOrder()` Trusts Solver Quote Output Amount

**File:** `src/backends/persistence.ts` — `prepareOrder()` lines ~275-280
**Severity:** MEDIUM

`outputAmount` is taken directly from `data.estimatedDestinationAmount` (the solver's quote). A malicious or compromised solver API could return an artificially low `outputAmount`, causing the user to sign an order that gives them far less than market rate.

The `getQuote()` method applies 0.5% slippage to create `minOutputRaw`, but `prepareOrder()` uses the raw `estimatedDestinationAmount` from the quote, not the slippage-adjusted amount. The on-chain order will commit to whatever output the solver quoted.

**Mitigation:** In `prepareOrder()`, validate that the output amount is within a reasonable range of the input amount (e.g., using a price oracle or minimum ratio). Alternatively, use the slippage-adjusted `minOutputRaw` as the on-chain output commitment.

### MEDIUM-002: EIP-712 Domain Missing `version` Field

**File:** `src/backends/persistence.ts` — `PERMIT2_DOMAIN` constant
**Severity:** MEDIUM

The EIP-712 domain for Permit2 is defined as:
```js
const PERMIT2_DOMAIN = {
  name: "Permit2",
  chainId: 0, // set dynamically
  verifyingContract: PERMIT2_ADDRESS,
};
```

The canonical Permit2 EIP-712 domain does NOT include a `version` field, so this is technically correct per the Uniswap Permit2 spec. However, ethers.js `signTypedData` may serialize the domain differently if other implementations expect it. **Verified: this is correct for Permit2.** Downgrading to informational.

**Status:** ✅ Correct — Permit2 domain omits `version` per spec.

### MEDIUM-003: `buildTransaction()` Returns Stub Data for MCP Flow

**File:** `src/backends/persistence.ts` — `buildTransaction()` lines ~430-450
**Severity:** MEDIUM

`buildTransaction()` returns `data: "0x"` — a placeholder that would be a no-op if submitted. The `execute-bridge` tool doesn't check for this and would pass it to transaction simulation, which would succeed (empty calldata to a contract is valid). The user would then sign and submit a meaningless transaction.

There's no guard in `execute-bridge.ts` to detect when a backend returns stub/placeholder transaction data.

**Mitigation:** Either:
1. Have `buildTransaction()` throw an error explaining that Persistence requires `signAndExecute()`, or
2. Add a sentinel field (e.g., `requiresExternalSigning: true`) that `execute-bridge.ts` checks

---

## Priority 2: Changes Since v4

### Across Symbol-Based Comparison ✅

**File:** `src/backends/across.ts` — `getQuote()` lines ~75-82
**Finding:** The symbol comparison uses `lookupByAddress()` from the verified token registry, which only returns curated tokens. A malicious token registry entry would need to be in the hardcoded `VERIFIED_TOKENS` array, which is source-controlled. **This is safe.**

However, if two different tokens share the same symbol in the registry (e.g., a hypothetical second "USDC" variant), Across would incorrectly attempt to bridge them. Currently no duplicates exist in the registry, but this is a latent risk.

**Status:** ✅ Acceptable — registry is hardcoded and curated.

### Relay Status Mapping v3 ✅

**File:** `src/backends/relay.ts` — `getStatus()` lines ~160-185
**Finding:** The v3 status mapping covers: `waiting`, `pending`, `submitted`, `success`, `delayed`, `failure`, `refund`, `refunded`. There's a good catch-all warning for unmapped statuses. **This is complete and correct.**

**Status:** ✅ Good — includes `delayed` and `refunded` states, plus unmapped status warning.

### deBridge Fee Retry Logic ✅

**File:** `src/backends/debridge.ts` — `getQuote()` and `buildTransaction()`
**Finding:** Both methods retry exactly once without affiliate fee params if the first request fails. There's no loop — it's a single `if` check with a direct retry. No information leakage (error messages are from the deBridge API, not internal state).

**Status:** ✅ Safe — single retry, no loop, no info leak.

### Rate Limiter Eviction ✅

**File:** `src/tools/get-quote.ts` — `evictStaleRateLimitEntries()`
**Finding:** Eviction runs every 100 calls and removes entries where ALL timestamps are older than the window. This is correct. The rate limit itself correctly prunes expired timestamps on each check.

**Minor note:** The eviction iterates the full map, which is O(n) but bounded by unique route keys. Acceptable for expected usage patterns.

**Status:** ✅ Correct.

### Chain ID Validation ✅

**File:** `src/utils/chains.ts` — `resolveChainId()`
**Finding:** Only accepts chain IDs that exist in the hardcoded `CHAINS` array. No false rejections possible for supported chains. Unsupported chains correctly return `null`.

**Status:** ✅ Correct.

---

## Priority 3: Full Codebase Re-scan

### LOW-001: `as any` Casts on `quoteData`

**Files:** All backends — `buildTransaction()` and `prepareOrder()` methods
**Count:** 10 instances across `persistence.ts`, `across.ts`, `relay.ts`, `debridge.ts`, `lifi.ts`, `listener.ts`

The `quoteData` field on `BridgeQuote` is typed as `unknown` but consistently cast to `any` without runtime validation. If a cached quote's `quoteData` structure changes between versions or gets corrupted, these casts would silently produce undefined values.

**Risk:** Low — the data flows from `getQuote()` to `buildTransaction()` within the same process, so structural mismatch is unlikely in practice. But for defense-in-depth, runtime validation (e.g., zod schemas) would be better.

### LOW-002: Test Scripts Use `process.env.TEST_BUYER_PRIVATE_KEY!`

**Files:** `scripts/test-persistence-e2e.ts`, `scripts/test-persistence-final.ts`, `scripts/test-persistence-full.ts`
**Finding:** Private key loaded from `.env.acp` via non-null assertion (`!`). The `.env.acp` file is in `.gitignore` ✅. No hardcoded keys found ✅.

**Risk:** Low — test scripts only, env file is gitignored. However, if someone runs these scripts without the env file, they'll get a confusing runtime error rather than a clear message.

### LOW-003: `fillerData` is 32 Zero Bytes

**File:** `src/backends/persistence.ts` — `signAndExecute()` line ~410
```js
const fillerData = ethers.zeroPadValue("0x", 32);
```

This passes 32 zero bytes as `fillerData` to `initiate()`. If the settlement contract expects specific filler identification data, this could cause the order to be unfillable or filled by any solver (which may be intended). Verify this matches the contract's expectation.

**Status:** Likely correct for an open/permissionless fill model, but confirm with the contract spec.

### LOW-004: No Test Coverage for `prepareOrder()` / `signAndExecute()`

**Finding:** The new Persistence EIP-712 flow has test scripts (`test-persistence-e2e.ts`, etc.) but no unit tests. The critical signing logic — domain construction, type hashing, nonce handling — is only tested via live mainnet transactions.

**Mitigation:** Add unit tests that verify:
- EIP-712 typed data structure matches Permit2 spec
- Nonce from contract is correctly propagated to the signature
- Approval amount matches input amount exactly
- Domain `chainId` is set correctly for each supported chain

---

## Resolved Since v4

| v4 Finding | Status |
|---|---|
| Across address comparison | ✅ Fixed — now uses symbol-based comparison via registry |
| Relay v2 status endpoint | ✅ Fixed — upgraded to v3 |
| deBridge native ETH handling | ✅ Fixed — fee retry logic handles gracefully |
| Fee env var error handling | ✅ Fixed — all backends retry without fee params on failure |

---

## Summary Table

| ID | Severity | Component | Description | Status |
|---|---|---|---|---|
| HIGH-001 | 🔴 HIGH | persistence.ts | Permit2 nonce reuse after failed initiate() | Open |
| HIGH-002 | 🔴 HIGH | persistence.ts | Approval persists after failed execution | Open |
| MEDIUM-001 | 🟡 MEDIUM | persistence.ts | Solver quote output amount not validated | Open |
| MEDIUM-002 | 🟢 INFO | persistence.ts | EIP-712 domain correct per Permit2 spec | Verified ✅ |
| MEDIUM-003 | 🟡 MEDIUM | persistence.ts | buildTransaction() returns stub for MCP | Open |
| LOW-001 | 🔵 LOW | all backends | `as any` casts on quoteData | Open |
| LOW-002 | 🔵 LOW | scripts/ | Private key handling in test scripts | Acceptable |
| LOW-003 | 🔵 LOW | persistence.ts | fillerData is 32 zero bytes | Verify |
| LOW-004 | 🔵 LOW | persistence.ts | No unit tests for EIP-712 flow | Open |

---

## Recommendations (Priority Order)

1. **HIGH-001 + HIGH-002:** Add cleanup logic to `signAndExecute()` — on `initiate()` failure, revoke the Permit2 allowance and warn about the nonce. Tighten `initiateDeadline` to 5-10 minutes.

2. **MEDIUM-003:** Make `buildTransaction()` throw for Persistence backend (it requires `signAndExecute()`), or add a detection mechanism in `execute-bridge.ts`.

3. **MEDIUM-001:** Validate solver output amount against a minimum ratio (e.g., at least 99% of input value for same-asset swaps).

4. **LOW-004:** Add unit tests for the EIP-712 signing flow.

---

*Overall assessment: The codebase is well-structured with good separation of concerns. The EIP-712 flow is architecturally sound but needs cleanup/rollback handling for the failure path. All other backends are clean.*
