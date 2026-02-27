# E2E Test Round 3 Results — 2026-02-26

## Summary

| # | Backend | Route | Amount | Status | Tx Hash | Received |
|---|---------|-------|--------|--------|---------|----------|
| 1 | **Squid** | Base USDC → OP USDC | 0.50 USDC | ❌ Nonce error | Approval: `0x3dd14f...` | — |
| 2 | **Across** | Base ETH → Arb ETH | 0.0005 ETH | ✅ Success | `0x88fd0538...e029ed3c` | 0.000495 ETH |
| 3 | **deBridge** | Arb USDC → Base USDC | 0.50 USDC | ✅ Success | `0xa3fcd144...97721922` | 0.4981 USDC |
| 4 | **Persistence** | BSC BTCB → Base cbBTC | 0.00005 BTCB | ✅ Success | `0x7e3b72d7...c06edf` | 0.00004956 cbBTC |

**3/4 passed.** Squid failed due to a nonce race condition (approval tx used nonce 35, but bridge tx also tried nonce 35 instead of 36). This is a transient issue — the Squid route data likely embedded a stale nonce or the RPC didn't return the updated nonce fast enough.

## Details

### Test 1: Squid ❌
- Quote obtained, approval tx confirmed (`0x3dd14f...`)
- Bridge tx failed: `nonce too low: next nonce 36, tx nonce 35`
- **Root cause:** Squid's `buildTransaction` calls `/route` with `quoteOnly=false` which returns a pre-signed/pre-nonced tx. The approval tx incremented the nonce, but the route response had cached the old nonce. Fix: let ethers manage the nonce instead of using the one from Squid's response, or wait for approval confirmation before calling buildTransaction.

### Test 2: Across ✅
- Base ETH → Arb ETH (0.0005 ETH)
- Before: 0.000572 ETH on Arb
- After: 0.001067 ETH on Arb
- Received: **0.000495 ETH** (~$0.01 fee)
- Bridge completed in <30s

### Test 3: deBridge ✅
- Arb USDC → Base USDC (0.50 USDC)
- Protocol fee: 0.001 ETH (value field)
- Before: 7.231 USDC on Base
- After: 7.729 USDC on Base
- Received: **0.4981 USDC** (~$0.002 fee)
- Bridge completed in <45s

### Test 4: Persistence ✅
- BSC BTCB → Base cbBTC (0.00005 BTCB)
- Full signAndExecute flow: Permit2 approval → EIP-712 signing → on-chain initiate → backend submit
- Order ID: `75b1de18-68ca-4afe-a229-49c1134d5ba2`
- Before: 0.0001193 cbBTC on Base
- After: 0.00016886 cbBTC on Base
- Received: **0.00004956 cbBTC**
- Bridge completed in <60s

## Squid Fix Needed
The Squid backend's `buildTransaction` should be called **after** approval is confirmed, not before. Currently the script calls `buildTransaction` once and gets back both `approvalTx` and the bridge tx — but the bridge tx has a baked-in nonce from when it was fetched. Solution: split into two calls, or override the nonce when sending.
