# BridgeKitty Live Test Results

**Date:** 2026-02-25T09:23–09:35 UTC  
**Wallet:** `0x221726819bcfDDC3B05be56369a14ac836E64B7F`  
**Overall Result:** 2/4 providers tested successfully, 1 bug found, 1 infra limitation

## Starting Balances

| Chain | USDC | ETH |
|-------|------|-----|
| Optimism | 2.206851 | 0.000136 |
| Arbitrum | 0.562716 | 0.000478 |
| Base | 0.119623 | 0.000020 |

## Test Results

### Round 1 (initial run with fee configs)

| # | Provider | Route | Amount | TX Hash | Status | Time | Notes |
|---|----------|-------|--------|---------|--------|------|-------|
| 1 | Relay | OP → Base | 0.30 USDC | `0x98d58ecb…` | ✅ completed | ~60s | Funds arrived (Base gained 0.27 USDC). Status API stuck on "in_progress" — **Relay status polling bug** |

### Round 2 (fee configs removed)

| # | Provider | Route | Amount | TX Hash | Status | Time | Notes |
|---|----------|-------|--------|---------|--------|------|-------|
| 2 | **LiFi** | OP → Arb | 0.25 USDC | `0x31f86329…` | ✅ completed | 32s | Polymer (Fast) route. Clean E2E including status tracking |
| 3 | **deBridge** | OP → Base | 0.25 USDC | — | ❌ insufficient ETH | — | deBridge requires ~0.001 ETH native value for protocol fees, wallet only had 0.000135 ETH |
| 4 | **Across** | Arb → OP | 0.25 USDC | — | ❌ no quotes | — | **BUG**: Across backend compares token addresses (`fromTokenAddress === toTokenAddress`) but USDC has different addresses per chain. Should compare by symbol. |
| 5 | **Relay** | OP → Base | 0.25 USDC | `0x719c4812…` | ✅ completed | ~30s | Funds arrived (Base gained 0.22 USDC). Status API again stuck on "in_progress" |

## Final Balances

| Chain | USDC | ETH |
|-------|------|-----|
| Optimism | 1.406851 | 0.000135 |
| Arbitrum | 0.812034 | 0.000478 |
| Base | 0.611003 | 0.000020 |

## Bugs Found

### 1. Across backend: token address comparison (CRITICAL)
**File:** `src/backends/across.ts:69`  
**Issue:** `if (params.fromTokenAddress.toLowerCase() !== params.toTokenAddress.toLowerCase()) return null;`  
USDC on Optimism (`0x0b2C639c...`) ≠ USDC on Arbitrum (`0xaf88d065...`), so Across always returns null for USDC bridges.  
**Fix:** Compare by token symbol or use Across API's own token resolution instead of comparing addresses.

### 2. Relay status polling never completes
**File:** `src/backends/relay.ts` (getStatus)  
**Issue:** Relay status API returns "in_progress" / "unknown" indefinitely even after funds have arrived at destination. Both Relay test transactions (0x98d58ecb… and 0x719c4812…) delivered funds to Base but status never showed "completed".  
**Impact:** Any agent using `bridge_status` for Relay will time out waiting.

### 3. deBridge requires native ETH for protocol fees
Not a bug per se, but `execute-bridge` should check if the wallet has enough native ETH for the `value` field before returning the transaction, or at least warn about the ETH requirement.

### 4. Fee configuration issues (env)
- `LIFI_FEE=0.003` requires portal.li.fi registration for fee collection → fails without it
- `DEBRIDGE_AFFILIATE_FEE=30` exceeds max of 10 → API rejects

## Provider Summary

| Provider | Quotes? | Execute? | Status Tracking? | Verdict |
|----------|---------|----------|-------------------|---------|
| **LiFi** | ✅ Multiple routes | ✅ | ✅ | **PASS** — fully working E2E |
| **deBridge** | ✅ | ❌ (needs more ETH) | untested | **PARTIAL** — quotes work, execution needs ETH |
| **Relay** | ✅ | ✅ | ❌ (stuck on in_progress) | **PARTIAL** — bridges work, status tracking broken |
| **Across** | ❌ (address comparison bug) | untested | untested | **FAIL** — needs code fix |

---

## Round 2 — Across & deBridge Retest

**Date:** 2026-02-25T09:57–10:01 UTC  
**Goal:** Verify Across fix (was broken for cross-chain stablecoins) and test deBridge from Arbitrum (more ETH for gas)

### Starting Balances (Round 2)

| Chain | USDC | ETH |
|-------|------|-----|
| Optimism | 1.406851 | 0.000135 |
| Arbitrum | 0.812034 | 0.000478 |
| Base | 0.611003 | 0.000020 |

### Bugs Fixed Before Round 2

#### 1. Across `expiresAt` set to exclusivity offset instead of timestamp (CRITICAL)
**File:** `src/backends/across.ts:160`  
**Issue:** `expiresAt: data.exclusivityDeadline ? Math.min(data.exclusivityDeadline * 1000, ...)` — The API returns `exclusivityDeadline: 5` (a relative offset in seconds), not an epoch timestamp. `5 * 1000 = 5000` which is always < `Date.now()`, so **every Across quote was immediately filtered as expired** by the routing engine.  
**Fix:** Changed to `expiresAt: Date.now() + 60_000` (60s TTL).

#### 2. Across `outputDecimals` defaults to 18 instead of actual token decimals
**File:** `src/backends/across.ts:101`  
**Issue:** `const decimals = params.fromTokenDecimals ?? 18` — The routing engine doesn't pass `fromTokenDecimals`, so it always defaulted to 18. For USDC (6 decimals), this made `minOutputAmount` display as "0.00000000".  
**Fix:** Use `data.inputToken?.decimals ?? params.fromTokenDecimals ?? 6`.

### Test Results (Round 2)

| # | Provider | Route | Amount | TX Hash | Status | Time | Notes |
|---|----------|-------|--------|---------|--------|------|-------|
| 1 | **Across** | Arb → OP | 0.55 USDC | `0x51bb715f…` | ✅ completed | 26s | After fixing expiresAt + decimals bugs. Got quote, approved, bridged, status tracked to completion. Output: 0.5497 USDC on OP. |
| 2 | **deBridge** | Arb → Base | 0.25 USDC | — | ❌ insufficient ETH | — | deBridge requires 0.001 ETH native value for protocol fees. Wallet only has 0.000475 ETH after Across gas spend. Need ~0.0012 ETH total (value + gas). |

### Final Balances (Round 2)

| Chain | USDC | ETH |
|-------|------|-----|
| Optimism | 1.956578 | 0.000135 |
| Arbitrum | 0.262034 | 0.000475 |
| Base | 0.611003 | 0.000020 |

### Updated Provider Summary (All Rounds)

| Provider | Quotes? | Execute? | Status Tracking? | Verdict |
|----------|---------|----------|-------------------|---------|
| **LiFi** | ✅ Multiple routes | ✅ | ✅ | **PASS** — fully working E2E |
| **Across** | ✅ (after fixes) | ✅ | ✅ | **PASS** — fully working E2E (min ~0.50 USDC) |
| **Relay** | ✅ | ✅ | ❌ (stuck on in_progress) | **PARTIAL** — bridges work, status tracking broken |
| **deBridge** | ✅ | ❌ (needs >0.001 ETH) | untested | **PARTIAL** — quotes work, execution needs native ETH for protocol fees |

### Notes
- Across has a minimum deposit of ~0.50 USDC (500049 raw units). Below this, API returns AMOUNT_TOO_LOW.
- Across is fast: 2s estimated, 26s actual including status confirmation.
- deBridge consistently requires 0.001 ETH in the tx `value` field for protocol fees on L2→L2 routes. This is a hard requirement that can't be avoided — need to fund the test wallet with more ETH to test.

## Recommendations

1. ~~**Fix Across token comparison**~~ ✅ Fixed in Round 1
2. ~~**Fix Across expiresAt + decimals bugs**~~ ✅ Fixed in Round 2 — quotes now appear and execute correctly
3. **Fix Relay status polling** — bridges work but agents can't confirm completion
4. **Add ETH balance pre-check** in execute-bridge for backends like deBridge that require native value
5. **Fix env configs** — DEBRIDGE_AFFILIATE_FEE should be in basis points (e.g. 3, not 30), LIFI_FEE needs portal setup
6. **Test deBridge execution** — needs wallet funded with ≥0.002 ETH on source chain to cover 0.001 ETH protocol fee + gas

## Round 3

**Date:** 2026-02-25 18:31 SGT

### Task 1: Swap USDC → ETH on Optimism (LiFi)

**Result: ✅ SUCCESS**

1. Swapped 1.5 USDC → ETH on Optimism via LiFi
   - Approval TX: `0x8dfacb2ca0ed4795b55943ae81aa4c31ac0209f7e8c647282cd7ddd2b8920d74`
   - Swap TX: `0x2a2ffdcfda7649d2c9ac9a9f5eb5e3a6adac00dc592838ef1586e0cd71eedc99`
   - Block: 148208392
   - ETH before: 0.000135 → ETH after: 0.000917
   - Estimated output: 782450435935975 wei (~0.000782 ETH)
2. Additional 0.25 USDC → ETH top-up swap
   - TX: `0x8eb8e21efbd49d75af05d2cde25b1ec24d4eeedf5711cb2bf8c8f06cf3cbe32f`
   - ETH after: 0.001047

### Task 2: Test deBridge Bridge (Optimism → Base)

**Result: ❌ FAILED — Insufficient funds for deBridge minimum**

- deBridge requires ~0.001 ETH protocol fee in tx `value` field
- deBridge's `prependOperatingExpenses` adds ~$0.23 USDC to cover destination gas
- For 0.10 USDC input, total pull = ~0.33 USDC (0.10 + 0.23 operating expenses)
- For 0.20 USDC input, total pull = ~0.43 USDC
- Available: 0.206 USDC + 0.001 ETH on Optimism — not enough
- First attempt reverted with "ERC20: transfer amount exceeds allowance" (stale approval amount from buildTransaction vs fresh create-tx)
- Second attempt (max approval) reverted with "ERC20: transfer amount exceeds balance"
- **Root cause:** deBridge has a high effective minimum (~$0.50 USDC) due to operating expenses

**Bug found in BridgeKitty's DeBridgeBackend:** The `buildTransaction` method calls `create-tx` separately from the approval, and operating expenses fluctuate between calls. The approval amount from the first call may be stale by the time the bridge tx executes. Fix: approve `MaxUint256` or re-fetch and approve in the same flow.

### Task 3: Balance Check (All Chains)

| Chain | Native | USDC | USDT |
|-------|--------|------|------|
| Ethereum | 0.0 ETH | 0.0 USDC | 0.0 USDT |
| Optimism | 0.001047 ETH | 0.206578 USDC | 0.0 USDT |
| Arbitrum | 0.000574 ETH | 0.062034 USDC | 0.0 USDT |
| Base | 0.000020 ETH | 0.611003 USDC | N/A |
| Polygon | 0.0 POL | 0.158311 USDC | 0.0 USDT |
| BSC | 0.001548 BNB | 0.0 USDC | 0.0 USDT |
| Avalanche | 0.0 AVAX | 0.0 USDC | 0.0 USDT |

**Total USDC across chains: ~$1.04**
**Total native tokens: negligible (< $5 combined)**

### Recommendations

1. **Fund wallet with more ETH** on Base or Optimism (need ≥0.002 ETH) to test deBridge
2. **Fix DeBridgeBackend approval race condition** — approve MaxUint256 or fetch create-tx and approve in same atomic flow
3. **deBridge effective minimum is ~$0.50 USDC** — document this in backend and reject quotes below minimum before attempting execution
4. **Base has the most USDC (0.61)** but barely any ETH — fund 0.002 ETH on Base to enable deBridge testing
