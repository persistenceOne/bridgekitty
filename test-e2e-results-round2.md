# BridgeKitty E2E Test Results — Round 2

**Date:** 2026-02-26 16:30-16:35 SGT  
**Wallet:** `0x221726819bcfDDC3B05be56369a14ac836E64B7F`

## Summary

| # | Backend | Route | Amount | Result | Notes |
|---|---------|-------|--------|--------|-------|
| 1 | Squid | Base USDC → OP USDC | 0.50 USDC | ❌ FAILED | Integrator ID invalid (needs Squid portal registration) |
| 2 | LI.FI (swap) | Base USDC → Base ETH | 2.00 USDC | ✅ SUCCESS | Received ~0.00097 ETH via Nordstern Finance |
| 3 | Across | Base ETH → Arb ETH | 0.001 ETH | ❌ FAILED | Backend bug: doesn't handle native ETH (no WETH mapping) |
| 4 | LI.FI (bridge) | Base USDC → Arb USDC | 1.00 USDC | ✅ SUCCESS | Received 0.991573 USDC via AcrossV4 |
| 5 | deBridge | Arb USDC → Base USDC | 0.50 USDC | ❌ FAILED | Insufficient Arb ETH for protocol fee (need 0.001, have 0.000572) |
| 6 | Persistence | BSC BTCB → Base cbBTC | 0.00005 BTCB | ✅ SUCCESS | Received 0.00004949 cbBTC |

**Score: 3/6 passed**

## Detailed Results

### ✅ Test 2: LI.FI Same-Chain Swap (Base USDC → Base ETH)
- Quote: 0.00097536 ETH via Nordstern Finance
- TX: `0x4f0397c97ee3f5023a47ac5408f195e3328b2aa4fe5d4247d8c20195323acaba`
- Gas used: 261,580
- Net received: 0.000969995 ETH (after gas)

### ✅ Test 4: LI.FI Cross-Chain Bridge (Base USDC → Arb USDC)
- Quote: 0.991535 USDC via AcrossV4, ETA 2s
- TX: `0x44d90f17a4b1e10079d48619c364bf6b79089b404ce0f15e0e25b365b99fdab0`
- Gas used: 179,372
- Received: 0.991573 USDC

### ✅ Test 6: Persistence (BSC BTCB → Base cbBTC)
- Quote: 0.00004974 cbBTC, fee $0.15, ETA 120s
- Initiate TX: `0x23dbaa86ea346e70e4d4274805ae557897a3bff628db452943d356c256a767d5`
- Order ID: `75b1de18-68ca-4afe-a229-49c1134d5ba2`
- Received: 0.00004949 cbBTC (arrived within ~10s!)

## Issues Found

### 1. Squid: Integrator ID Not Registered
- `SQUID_INTEGRATOR_ID` env var not set; defaults to `bridgekitty-test` which returns 401
- **Fix:** Register at Squid portal and set `SQUID_INTEGRATOR_ID` in `.env`

### 2. Across: No Native ETH Support
- Across API rejects `0xEeee...` (native ETH sentinel) with "Unsupported token"
- Using WETH address works for quote, but `buildTransaction` treats WETH as ERC20 (value=0x0)
- Need to either: wrap ETH first, or add WETH↔native mapping in the backend
- **Bug:** `across.ts` needs a `WETH_BY_CHAIN` map to convert native ETH addresses to WETH for the API, then set `value` to the deposit amount for native sends

### 3. deBridge: Protocol Fee Requires Native ETH
- deBridge charges ~0.001 ETH protocol fee via `value` field
- Wallet only had 0.000572 ETH on Arbitrum
- **Not a code bug** — just insufficient test wallet funds
- Also: `DEBRIDGE_AFFILIATE_FEE` appears to be >10% causing API errors (falls back to no-fee)

### 4. LI.FI: First Run Approval Bug (FIXED)
- Initial test sent approval to wrong spender (my test script bug, not backend bug)
- Backend's `approvalTx` is correctly structured — must send it as raw tx, not parse spender from it
- The `approvalTx.to` is the TOKEN contract, `approvalTx.data` encodes `approve(spender, amount)`

## Balances After Tests
- Base: ~0.0016 ETH, ~5.23 USDC, ~0.00012 cbBTC
- BSC: ~0.0014 BNB, ~0.000132 BTCB
- Arb: ~0.00057 ETH, ~1.14 USDC
- OP: ~0.20 USDC

## Gas Costs (wasted on failed txs)
- Test 2 first attempt (revert): ~109k gas ≈ $0.003
- Test 3 (Across revert): ~48k gas ≈ $0.001
- Test 4 first attempt (revert): ~85k gas ≈ $0.002
- Total wasted: ~$0.006
