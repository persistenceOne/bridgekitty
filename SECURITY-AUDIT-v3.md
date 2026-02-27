# BridgeKitty Security Audit v3 (Final)

**Date:** 2026-02-25
**Auditor:** Claw Security (third-pass deep review)
**Scope:** All source files in `src/`, `package.json`, dependency tree
**Prerequisite:** All v1 and v2 findings were reportedly fixed. This audit verifies v2 fixes, performs deep edge-case analysis, and checks dependencies.

---

## Executive Summary

All 6 v2 findings have been properly fixed. The codebase is well-structured with defense-in-depth patterns throughout. This deep audit found **1 MEDIUM**, **3 LOW**, and **3 INFO** issues — all edge cases that require specific conditions to trigger. No critical or high-severity issues remain.

**The codebase is suitable for public release** with the recommended fixes below.

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 1 | Cross-backend quote comparison unfairness (decimal mismatch) |
| LOW | 3 | Various edge cases |
| INFO | 3 | Code quality observations |

---

## Part 1: Verification of v2 Fixes

### ✅ NEW-MEDIUM-001: Cheapest Sort Logic (Fixed)
**Status: VERIFIED FIXED — correctly implemented**

The sort in `routing/engine.ts` now compares `minOutputAmountRaw` as BigInt (highest output wins), with gas cost as a tiebreaker only when outputs are within 0.1%. This is the correct approach.

**Edge case analysis:**
- **`minOutputAmountRaw = "0"`**: BigInt("0") works fine. A 0-output quote would sort last. The `outputBig <= 0n` check in Across filters these out at the backend level, but other backends could theoretically return "0". Not harmful — just sorted last.
- **Quotes with different token decimals on same route**: This is a real concern — see V3-MEDIUM-001 below.

### ✅ NEW-MEDIUM-002: Rate Limiter Eviction (Fixed)
**Status: VERIFIED FIXED — correctly implemented**

`evictStaleRateLimitEntries()` runs every 100 calls, iterating the map and deleting entries with no recent timestamps. The counter `rateLimitCheckCount` increments monotonically.

**Edge case analysis:**
- **Can it be tricked?** No. The eviction is based on timestamp freshness, not caller identity. An attacker sending many different route keys would trigger eviction every 100 calls regardless.
- **Counter reset?** The per-route timestamps are pruned on every `checkRateLimit` call (line `const recent = timestamps.filter(...)`). The eviction is an additional memory-bounding mechanism. Both work correctly together.
- **Memory bound**: In worst case between evictions, an attacker could create ~100 unique route keys. Each entry is a small array of timestamps. This is bounded and acceptable.

### ✅ NEW-LOW-001: BigInt Precision Loss in Gas Estimation (Fixed)
**Status: VERIFIED FIXED**

`gas-estimator.ts` now divides in BigInt first (`gasCostWei / 10n**9n`) then converts to Number and divides by 1e9. This keeps intermediate values within safe Number range for any realistic gas cost.

### ✅ NEW-LOW-002: Across Hardcoded Spoke Pool Addresses (Fixed/Documented)
**Status: VERIFIED — documented with update instructions**

The `SPOKE_POOLS` record in `across.ts` includes a comment with verification date (2025-02-25) and a link to Across docs. Addresses cover 8 chains. This is acceptable — the addresses are static contract deployments.

### ✅ NEW-LOW-003: Chain ID Validation (Fixed)
**Status: VERIFIED FIXED**

`routing/engine.ts` `getQuotes()` validates both `fromChainId` and `toChainId` against `getAllChains()` before querying backends. The validation uses the `CHAINS` array in `chains.ts` (14 chains).

**Edge case analysis:**
- **Does it accidentally block valid routes?** `resolveChainId()` in `chains.ts` accepts any positive integer as a chain ID (`Number.isInteger(num) && num > 0`). However, the engine then validates against `getAllChains()` which only has 14 hardcoded chains. So a user passing chain ID `250` (Fantom) would pass `resolveChainId` but fail the engine validation. This is **intentional** — BridgeKitty only supports listed chains, and LiFi would handle unsupported chains anyway. The error message includes the full list of supported chains. **No issue.**

### ✅ NEW-LOW-004: ACP Fee Verification (Fixed)
**Status: VERIFIED FIXED**

`listener.ts` `onNewTask()` now checks `job.fee ?? job.price` against `config.servicePriceUsd` and rejects if below minimum. Uses `as any` casts since the ACP SDK types may not expose fee directly — acceptable given the SDK's evolving API.

**Edge case analysis:**
- **Race conditions in ACP flow?** The fee check happens in the REQUEST→NEGOTIATION phase (before accepting). Payment verification happens in TRANSACTION→EVALUATION phase (SDK handles this). There's no race — the phases are sequential and the SDK enforces the lifecycle.
- **What if `jobFee` is null?** The code handles this: `if (jobFee !== null && jobFee !== undefined)` — if fee is unknown, the job is accepted (fail-open). This is a deliberate design choice documented in the v2 audit.

---

## Part 2: New Findings

### V3-MEDIUM-001: Cross-Backend Quote Comparison Unfairness — Decimal Mismatch

**File:** `src/routing/engine.ts`, cheapest sort logic
**Severity:** MEDIUM

The cheapest sort compares `minOutputAmountRaw` as BigInt across different backends. This works correctly **only when all backends return amounts in the same token with the same decimals.** However, this assumption can break:

**Scenario:** Bridge USDC from Ethereum (6 decimals) to BSC. The destination token varies:
- LiFi might route through BSC's Binance-Peg USDC (18 decimals) → `minOutputAmountRaw = "99500000000000000000"` (99.5 with 18 decimals)
- deBridge might return native USDC equivalent (6 decimals) → `minOutputAmountRaw = "99500000"` (99.5 with 6 decimals)

The BigInt comparison would rank the 18-decimal amount astronomically higher, even though both represent ~99.5 USDC.

**Why this happens:** BSC USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`) uses 18 decimals (documented in `token-registry.ts` `decimalOverrides`), while standard USDC uses 6. If different backends resolve to different USDC variants on BSC, the raw amounts are incomparable.

**Current mitigation:** In practice, this is partially mitigated because:
1. The tool layer resolves `toToken` to a specific address before calling the engine
2. All backends receive the same `toTokenAddress`
3. deBridge and Across use the user-specified destination token

However, LiFi's aggregator may internally swap to a different USDC variant (bridged vs native) and return amounts in that token's decimals. The `toDecimals` on the route's last step could differ from what was requested.

**Impact:** On BSC routes involving USDC/USDT (which have 18 decimals on BSC vs 6 elsewhere), LiFi routes could be unfairly ranked above or below direct protocol routes.

**Recommendation:** Normalize `minOutputAmountRaw` to a common decimal base before comparison. The `toTokenDecimals` is available in `QuoteParams` — use it to normalize:
```typescript
// Normalize to common base (e.g., 18 decimals) before comparing
const aNorm = aOutput * 10n ** BigInt(18 - (a.outputDecimals ?? 18));
const bNorm = bOutput * 10n ** BigInt(18 - (b.outputDecimals ?? 18));
```
This requires adding `outputDecimals` to `BridgeQuote` (backends already know it).

---

### V3-LOW-001: Circuit Breaker — Concurrent HALF_OPEN Requests

**File:** `src/utils/circuit-breaker.ts`, `isAllowed()` method
**Severity:** LOW

When the circuit transitions from OPEN → HALF_OPEN, the `isAllowed()` method returns `true`. The comment says "Only one request is allowed in HALF_OPEN." However, in a concurrent environment (multiple `getQuotes` calls in parallel), multiple requests could check `isAllowed()` simultaneously when the cooldown expires, and ALL would see `HALF_OPEN` and proceed.

This means the "single probe request" guarantee is violated under concurrency. If the backend is still failing, multiple requests would fail instead of just one.

**Impact:** LOW — the circuit breaker still works correctly in aggregate (it transitions back to OPEN on failure). The only impact is slightly more requests hitting a failing backend during the HALF_OPEN window. In BridgeKitty's typical load (MCP tool calls are sequential per user), this is unlikely to be an issue.

**Recommendation:** Add a `halfOpenLock` boolean that's set to `true` when the first HALF_OPEN request is allowed, preventing subsequent concurrent requests. Or accept the current behavior as adequate for the expected load.

---

### V3-LOW-002: Across `depositV3` Calldata — No ABI Encoding Validation

**File:** `src/backends/across.ts`, `buildTransaction()` method
**Severity:** LOW

The Across backend manually constructs ABI-encoded calldata for `depositV3` by string-concatenating hex-padded values. This is correct for the current function signature but fragile:

1. **No dynamic bytes encoding offset validation**: The `messageOffset` is hardcoded to `12 * 32` (384 bytes = offset to the 13th word). This is correct for 12 fixed parameters + 1 dynamic `bytes`. But if the function signature ever changes or if there's an off-by-one, the calldata would be silently malformed.

2. **The `message` parameter offset calculation**: The code uses `12 * 32` as the offset. Counting the parameters: depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityDeadline, message = 12 parameters. The offset for `message` (parameter index 11, 0-based) should point to byte `12 * 32 = 384`, which is the start of the dynamic data section. The length is `0` (empty message) followed by no data. **This is correct.**

3. **However**, the `message` bytes is the 12th parameter (0-indexed: 11). In ABI encoding, the first 12 words (0-11) are the fixed-size params, where word 11 contains the **offset** to the dynamic data. So the offset stored in word 11 should be `12 * 32 = 384 = 0x180`. Looking at the code: `messageOffset = (12 * 32).toString(16).padStart(64, "0")` → `"0000...0180"`. Then the 13th word is the length `0`. **This is correct.**

**Residual risk:** If Across upgrades from `depositV3` to `depositV4` with different parameters, this manual encoding would silently produce invalid calldata. The transaction simulation (`simulateTransaction`) would catch this, but only if an RPC is configured.

**Recommendation:** Consider using ethers v6 `Interface.encodeFunctionData()` for type-safe ABI encoding. This would catch parameter count/type mismatches at build time:
```typescript
import { Interface } from "ethers";
const iface = new Interface(["function depositV3(...)"]);
const data = iface.encodeFunctionData("depositV3", [...params]);
```

---

### V3-LOW-003: `resolveChainId` Accepts Any Positive Integer But Engine Rejects Unknown Chains — Inconsistent Behavior

**File:** `src/utils/chains.ts` + `src/routing/engine.ts`
**Severity:** LOW

`resolveChainId("250")` returns `250` (Fantom). But the engine then rejects it as unsupported. The `bridge_get_quote` tool calls `resolveChainId` first and only checks for `null` return. A user passing chain ID `250` would get past the tool-layer validation only to hit the engine-layer validation with a different error message.

This creates confusing UX: the tool says "resolved chain 250" but then the engine says "unsupported chain 250."

**Recommendation:** Either have `resolveChainId` only accept known chains, or have the tool layer use the same `getAllChains()` check. Minor UX issue.

---

### V3-INFO-001: `quoteData as any` — Type Safety Gap in `buildTransaction`

All 5 backends cast `quote.quoteData as any` in `buildTransaction()`. This means there's no compile-time verification that the quote data structure matches expectations. If a backend's API changes its response format, the error would only surface at runtime.

**8 total `as any` casts** — all are in boundary code (SDK interop or API response handling). This is pragmatic given the external API nature but worth noting.

**Recommendation:** Define typed interfaces for each backend's quote data (e.g., `LiFiRouteData`, `DeBridgeQuoteData`) and cast to those instead of `any`. Low priority — the runtime behavior is correct.

---

### V3-INFO-002: LiFi Quote Expiry — 30s Hardcoded May Be Too Aggressive

**File:** `src/backends/lifi.ts`, line ~153
**Severity:** INFO

LiFi quotes get a hardcoded 30s expiry (`Date.now() + 30_000`). The comment says "DEX prices shift rapidly." However, the LiFi API doesn't provide an explicit expiry. In practice, LiFi's `/advanced/stepTransaction` endpoint re-fetches the current route state, so the 30s is mainly a freshness hint.

If a user takes >30s to review quotes (common in agent-driven workflows), all LiFi quotes would be filtered as expired, requiring a re-quote. This isn't a security issue but could cause UX friction.

---

### V3-INFO-003: Dependency Audit — 17 Low-Severity Vulnerabilities (All Transitive)

```
npm audit: 17 low severity (0 moderate, 0 high, 0 critical)
```

All 17 vulnerabilities are in transitive dependencies of `@virtuals-protocol/acp-node`, specifically in ethers v5 (`@ethersproject/*`) packages used by `alchemy-sdk`. BridgeKitty itself uses ethers v6 directly.

**Affected transitive chain:** `@virtuals-protocol/acp-node` → `@account-kit/*` → `alchemy-sdk` → `@ethersproject/*` (v5)

The ethers v5 vulnerabilities are:
- `@ethersproject/abi`: Prototype pollution in tuple parsing (low)
- `@ethersproject/transactions`: Transaction parsing edge cases (low)

**Impact on BridgeKitty:** None. BridgeKitty's own code uses ethers v6. The vulnerable v5 packages are only used internally by the Virtuals ACP SDK for its own contract interactions. BridgeKitty never passes user-controlled input directly to these v5 parsing functions.

**ethers v6 usage check:** BridgeKitty uses `ethers` v6 only in `isValidEvmAddress()` for EIP-55 checksum validation via `getAddress()`. This is a safe, well-tested function with no known vulnerabilities.

**Recommendation:** No action needed. When `@virtuals-protocol/acp-node` updates their `alchemy-sdk` dependency, these will resolve automatically.

---

## Part 3: Deep Edge Case Analysis

### ✅ Double-Processing of ACP Jobs (Reentrancy-like)

The ACP listener uses a semaphore for concurrency control and phase-matching (`job.phase === AcpJobPhases.TRANSACTION && memoToSign?.nextPhase === AcpJobPhases.EVALUATION`) to process only payment-confirmed jobs. The same job cannot be processed twice because:
1. The ACP SDK manages job lifecycle — once a job transitions to EVALUATION, it won't fire TRANSACTION again
2. The semaphore doesn't prevent duplicate processing (it's for concurrency limits), but the SDK does

**No issue found.**

### ✅ Zero-Amount Quotes

- Engine: `validateQuoteParams` rejects `amountBig <= 0n` — **handled**
- Tool: `get-quote.ts` validates `amountNum <= 0` and regex `^\d+\.?\d*$` — **handled**
- Persistence: `validateAmount` rejects `amt <= 0n` — **handled**
- Across: `outputBig <= 0n` returns null — **handled**

### ✅ Negative Amounts

BigInt constructor on negative strings like `"-100"` would succeed but `<= 0n` check catches it. The tool-layer regex `^\d+\.?\d*$` rejects negative strings before they reach the engine. **Handled at both layers.**

### ✅ Amounts > uint256

`BigInt(params.amountRaw)` in the engine accepts arbitrarily large integers. These would be rejected by the backend APIs (which enforce uint256 limits) or by the on-chain transaction. The `buildApproveData` function uses `BigInt(amount).toString(16)` which works for any size but would produce invalid EVM calldata for amounts > 2^256. However, no token has this much supply, so this is theoretical. **Acceptable risk.**

### ✅ Circuit Breaker — Forced Permanently Open

An attacker cannot force the circuit breaker permanently open because:
1. Failures must be within the `failureWindowMs` (5 minutes) — old failures are pruned
2. After OPEN, the circuit transitions to HALF_OPEN after `cooldownMs` (30s)
3. HALF_OPEN allows a probe request — if the backend recovers, the circuit closes
4. Even if the probe fails, extended cooldown is only 60s before next probe

The only way to keep a circuit open is to continuously cause backend failures (DDoS). But this requires actual backend calls to fail — the attacker can't manipulate the circuit breaker from the outside. **No issue.**

### ✅ Token Decimal Handling Across Backends

The token registry correctly handles decimal overrides (BSC USDC/USDT = 18 decimals). Each backend receives the resolved decimals through `fromTokenDecimals`/`toTokenDecimals` in `QuoteParams`. The concern about cross-backend decimal mismatch in quote **comparison** is documented in V3-MEDIUM-001 above.

### ✅ TODO/FIXME/HACK Comments

**None found** in any source file. The codebase is clean of known-issue markers.

---

## Part 4: Architecture Review Summary

The codebase follows a clean, defensive architecture:

1. **Input validation** at 3 layers: tool (Zod schemas + regex), engine (`validateQuoteParams`), backends (per-backend validation)
2. **Quote caching** with expiry and pre-build freshness checks
3. **Transaction simulation** before returning unsigned tx data
4. **Circuit breaker** preventing cascade failures
5. **Rate limiting** with memory-bounded eviction
6. **Error sanitization** at the ACP boundary
7. **Exact-amount approvals** (not unlimited)
8. **No private key handling** in the MCP path (only ACP listener)

---

## Prioritized Recommendations

1. **V3-MEDIUM-001** — Add output decimals to `BridgeQuote` and normalize before comparison. **Affects BSC routes.**
2. **V3-LOW-002** — Consider using ethers v6 `Interface` for ABI encoding in Across backend. **Defense in depth.**
3. **V3-LOW-003** — Align chain validation between `resolveChainId` and engine. **UX improvement.**
4. **V3-LOW-001** — Optionally add HALF_OPEN concurrency guard. **Marginal improvement.**

---

## Conclusion

BridgeKitty's codebase is **production-ready**. All v1 and v2 findings have been properly fixed. The new findings are edge cases with limited real-world impact. The most actionable item is V3-MEDIUM-001 (decimal normalization for BSC routes), which should be addressed before heavy BSC usage.

The dependency tree is clean of critical vulnerabilities. The 17 low-severity transitive issues in the Virtuals ACP SDK's ethers v5 dependencies do not affect BridgeKitty's security posture.

**Final verdict: ✅ Clear for public release** with V3-MEDIUM-001 as a recommended pre-release fix.
