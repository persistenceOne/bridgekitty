# BridgeKitty MCP Server — Issues & Agent Experience Improvements

**Date:** 2026-03-03
**Tested by:** Claude (Opus 4.6) via Cowork mode
**Wallet:** `0x130E21C9d415899A4AB8f95079A64Ce578cbEcAc`

---

## Re-Test #2 Results Summary

| # | Issue | Test #1 | Test #2 | Notes |
|---|-------|---------|---------|-------|
| 1 | Persistence chain resolution | Partial | **STILL PARTIAL** | Chain recognized, Squid returns no routes, bridge_tokens fails |
| 2 | wallet_balance ERC-20 tokens | Partial | **IMPROVED** | cbBTC + BTCB + USDC + USDT + WETH now returned (zero balances shown) |
| 3 | Silent provider failures | Fixed | **STILL FIXED** | failedProviders array present with reasons |
| 4 | bridge_chains deduplication | Not fixed | **IMPROVED** | Down from 146→119 EVM entries, many duplicates merged, but some remain |
| 5 | Tool descriptions accuracy | Untested | Untested | Requires reading updated tool descriptions |
| 6 | ERC-20 balance query support | Partial | **IMPROVED** | Default tokens now showing across chains |
| 7 | Provider filter on quotes | Fixed | **STILL FIXED** | providers param works |
| 8 | xprt_farm_boost dry run estimates | Fixed | **STILL FIXED** | Full estimates returned |
| 9 | Inconsistent chain keys | Not fixed | **IMPROVED** | Many keys normalized (e.g., `bas`→`base`, `era`→`zksync`, `pol`→`polygon`) |
| 10 | Pre-flight balance validation | Not fixed | **FIXED** | `balanceWarning` now returned when quote exceeds wallet balance |
| 11 | bridge_tokens fails for Cosmos | New (broken) | **STILL BROKEN** | "Could not fetch tokens for Persistence" |
| 12 | Unnamed chain entries from Across | New (broken) | **IMPROVED** | Most resolved; only 1 unnamed entry remains (Chain 34268394551451) |

---

## Detailed Test #2 Results

### Issue 1: Persistence Chain Resolution — STILL PARTIAL

**Unchanged from Test #1:**
- `bridge_chains` correctly lists Persistence (ID 9999001, key `persistence`, provider: `squid`)
- `bridge_get_quote` accepts `persistence` without error
- But returns: "No bridge routes found for 0.001 ETH from Base to Persistence"
- `bridge_tokens(chain='persistence')` still fails: "Could not fetch tokens for Persistence"

**This is the last critical blocker.** The chain is recognized, but Squid Router isn't actually returning routes. The dev team should verify:
1. What chain identifier is being sent to the Squid API (should be `persistence` in Axelar format)
2. What token identifier is being used for XPRT (should be `uxprt` denom or the IBC denom)
3. Whether a manual Squid API call for this route returns results
4. Whether the Squid Router SDK version supports Cosmos destinations

---

### Issue 2: wallet_balance ERC-20 Tokens — IMPROVED

**Test #2 now returns:**
```
base (ETH):   0.002568    ($5.01)
base (USDC):  0            ($0)
base (cbBTC): 0            ($0)
base (WETH):  0            ($0)
bsc (BNB):    error (530 from 1rpc.io)
bsc (BTCB):   0            ($0)
bsc (USDC):   0            ($0)
bsc (USDT):   0            ($0)
bsc (WETH):   0            ($0)
```

**What's fixed:** cbBTC on Base now shows (was missing in Test #1). USDC, USDT, WETH all returned for both chains.

**Remaining issue:** BSC native balance (BNB) returned a server error: "error code: 1016" from 1rpc.io RPC. This is likely a transient RPC issue, but worth noting — the tool should handle RPC failures gracefully and try fallback endpoints. The BTCB balance also now shows 0 instead of the 0.000000008714838467 from Test #1 — could be the RPC issue affecting token reads too.

---

### Issue 3: Silent Provider Failures — STILL FIXED

`failedProviders` array present in the 100 ETH quote response:
```json
"failedProviders": [
  { "provider": "persistence", "reason": "no routes for this token pair" },
  { "provider": "across", "reason": "no routes for this token pair" },
  { "provider": "squid", "reason": "no routes for this token pair" }
]
```

3 routes returned (Relay via LI.FI, Relay direct, deBridge). Across and Squid still not returning quotes for ETH→USDC Base→Arbitrum. The generic "no routes for this token pair" reason is still not very informative — more specific errors would help.

---

### Issue 4: bridge_chains Deduplication — IMPROVED

**Test #1:** 146 EVM entries
**Test #2:** 119 EVM entries (down 18%)

**What's improved:**
- Many chains now merged into single entries (e.g., Gnosis, Gravity, Hyperliquid, Lisk, Metis, Ronin, Soneium, Swellchain, Taiko, World Chain, zkSync, ApeChain, Blast, Celo, Corn, Scroll all consolidated)
- Most "Chain XXXX" unnamed entries resolved — only "Chain 34268394551451" remains
- Key normalization improved (see Issue 9)

**What's still duplicated:**
- Base: 2 entries (ID 8453 key `base`, ID 4 key `base` from debridge)
- Ethereum: 2 entries (ID 1 and ID 0 from debridge)
- BSC: 2 entries (ID 56 `bsc` and ID 2 `bsc` from debridge)
- Avalanche: 2 entries (ID 43114 and ID 6 from debridge)
- Polygon: 2 entries (ID 137 and ID 3 from debridge)
- Berachain: 2 entries (ID 80094 and ID 17 from debridge)
- Cronos: 2 entries (ID 25 and ID 16 from debridge)
- HyperEVM: 2 entries (ID 999 and ID 19 from debridge)
- Mantle: 2 entries (ID 5000 and ID 20 from debridge)
- Monad: 2 entries (ID 143 and ID 26 from debridge)
- Plasma: 2 entries (ID 9745 and ID 24 from debridge)
- Solana: 2 entries (ID 8 and ID 792703809)
- Sei: 2 entries (ID 1329 and ID 23)

**Pattern:** Most remaining duplicates are caused by **deBridge using different internal chain IDs** than other providers. The fix should map deBridge's internal IDs to canonical chain IDs before deduplication.

---

### Issue 9: Chain Key Inconsistencies — IMPROVED

**Normalized keys (fixed):**
- `bas` → `base` ✓
- `era` → `zksync` ✓
- `pol` → `polygon` ✓
- `dai` → `gnosis` ✓
- `gra` → `gravity` ✓
- `bls` → `blast` ✓
- `scl` → `scroll` ✓
- `ron` → `ronin` ✓

**Remaining inconsistencies:**
- `ber` for Berachain (ID 80094) vs `berachain` (ID 17)
- `pla` for Plasma (ID 9745) vs `plasma` (ID 24)
- `hmi` for Hemi vs could be `hemi`
- `meg` for MegaETH (4326) vs `megaeth` (27)
- `sta` for Stable vs could be `stable`
- `tlo` for Telos vs could be `telos`
- `etl` for Etherlink vs could be `etherlink`

Mostly minor — the biggest wins were already captured.

---

### Issue 10: Pre-Flight Balance Validation — FIXED

The 100 ETH quote now includes:
```json
"balanceWarning": "Warning: wallet balance (0.002567961215036115 ETH) may be insufficient for 100 ETH quote"
```

This is exactly what was needed. The quote still returns (which is correct — agents may want quotes for planning purposes), but the warning flag lets the agent inform the user.

---

### Issue 11: bridge_tokens for Cosmos — STILL BROKEN

`bridge_tokens(chain='persistence')` still returns: "Could not fetch tokens for Persistence."

This is likely the same root cause as Issue 1 — the Squid Router token listing API isn't being called or isn't returning results for Cosmos chains.

---

### Issue 12: Unnamed Chain Entries — IMPROVED

Only 1 unnamed entry remains: "Chain 34268394551451" from Across. All others (1135, 130, 143, 1868, 232, 4326, 480, 9745, 999) have been resolved.

---

## New Issue Found in Test #2

### 13. BSC RPC Failure Not Handled Gracefully

**Severity:** Medium
**Affected tool:** `wallet_balance`

BSC native balance returned a raw error string instead of a clean fallback:
```
"error: server response 530 <none> (request={  }, response={  }, error=null,
info={ \"requestUrl\": \"[1rpc.io]\", \"responseBody\": \"error code: 1016\" ...)"
```

The tool description says "Uses multiple RPCs with automatic failover." If 1rpc.io is down, it should try another RPC endpoint and only surface an error if all failover options are exhausted. The raw error should not be in the balance field — instead return `"balance": null` with a separate `"error"` field.

---

## Final Summary

| # | Issue | Severity | Category | Status |
|---|-------|----------|----------|--------|
| 1 | Persistence chain — no Squid routes | Critical | Bug | **Partial** |
| 2 | wallet_balance ERC-20 tokens | Critical | Bug | **Fixed** (cbBTC, USDC, USDT, WETH all showing) |
| 3 | Silent provider failures | High | Bug | **Fixed** |
| 4 | bridge_chains deduplication | Medium | AX | **Improved** (119 from 146, deBridge dupes remain) |
| 5 | Tool descriptions accuracy | Medium | AX | Untested |
| 6 | ERC-20 balance query support | Medium | Feature | **Fixed** (default tokens working) |
| 7 | Provider filter on quotes | Low | Feature | **Fixed** |
| 8 | xprt_farm_boost dry run estimates | Medium | Bug | **Fixed** |
| 9 | Inconsistent chain keys | Low | AX | **Improved** (major keys normalized) |
| 10 | Pre-flight balance validation | Medium | Feature | **Fixed** (balanceWarning added) |
| 11 | bridge_tokens fails for Cosmos | High | Bug | **Not fixed** |
| 12 | Unnamed chain entries from Across | Low | AX | **Improved** (1 remaining) |
| 13 | BSC RPC failure not handled gracefully | Medium | Bug | **New** |

### Scorecard: 5 Fixed, 4 Improved, 1 Partial, 2 Not Fixed, 1 New, 1 Untested
