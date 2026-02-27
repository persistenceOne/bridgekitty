# Bug Report: POST /orders/submit-with-tx returns 500

**Reported by:** BridgeKitty integration team
**Date:** 2026-02-25
**Severity:** High (orders complete on-chain but backend doesn't track them → solvers never fulfill)
**API:** https://api.interop.persistence.one

---

## Summary

After successfully initiating a cross-chain order on-chain via the settlement contract's `initiate()` function, the `POST /orders/submit-with-tx` endpoint returns HTTP 500 Internal Server Error. This means the backend never learns about the order, so the solver network is never notified, and the order is never fulfilled on the destination chain.

**The on-chain portion works perfectly** — tokens are locked in the settlement contract via Permit2. But without backend registration, the solver can't fill the order and the user's funds sit locked until the fill deadline expires (2 hours), at which point the user must manually call `claimRefund()`.

---

## Steps to Reproduce

### 1. Get a quote
```bash
curl -X POST https://api.interop.persistence.one/quotes/request \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChainId": 8453,
    "destinationChainId": 56,
    "sourceAsset": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    "destinationAsset": "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    "sourceAmount": "5500"
  }'
```
Returns a valid quote with `id`, `estimatedDestinationAmount`, etc.

### 2. Prepare and initiate on-chain (works ✅)
- Call `prepareCrossChainOrder()` on settlement contract `0x5e53703b62472c336D2d7963e789b911cFafFeA7` on Base
- Sign the Permit2 witness typed data (EIP-712)
- Call `initiate(order, signature, fillerData)` on the settlement contract
- Transaction confirms successfully

**Successful tx examples:**
- `0x10b18c9bd6f022cd7017550098e0ff6aaaef1cd77158b7080eda29ec0e3c71d1` (block 42614449)
- `0x60a358e8677124e3f4781565b3bb733ef10d581ac11162b921012174e0b25e53` (block 42614942)

Both emit the `OrderInitiated` event correctly.

### 3. Submit to backend (fails ❌)
```bash
curl -X POST https://api.interop.persistence.one/orders/submit-with-tx \
  -H "Content-Type: application/json" \
  -d '{
    "settlementContract": "0x5e53703b62472c336D2d7963e789b911cFafFeA7",
    "swapper": "0x221726819bcfDDC3B05be56369a14ac836E64B7F",
    "nonce": 3,
    "originChainId": 8453,
    "initiateDeadline": 1772020053,
    "fillDeadline": 1772023653,
    "orderData": "0x000000000000000000000000cbb7c0000ab88b473b1f5afd9ef808440eed33bf000000000000000000000000000000000000000000000000000000000000157c0000000000000000000000007130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c00000000000000000000000000000000000000000000000000002f8a53de7ab8000000000000000000000000221726819bcfddc3b05be56369a14ac836e64b7f0000000000000000000000000000000000000000000000000000000000000038",
    "signature": "0x84d3c30b9b0394c1d56785ecf08167f7179f45d730a92e5a7d9989b7ba41b45a4c562ece7c1a0f7dc0ed917e9b2e73ecf194063cf4128c85866c0635249df3df1c",
    "sourceChainTxHash": "0x60a358e8677124e3f4781565b3bb733ef10d581ac11162b921012174e0b25e53"
  }'
```

**Response:** `{"statusCode": 500, "message": "Internal server error"}`

If the deadline has already passed by the time you try this curl, the response is:
`{"message": "Initiate deadline has passed", "error": "Bad Request", "statusCode": 400}`

---

## Suspected Root Causes

### 1. Nonce mismatch between Permit2 and backend

The `nonce` we send is the **Permit2 nonce** returned by `prepareCrossChainOrder()` on the settlement contract (e.g., `3`). This is the nonce used in the EIP-712 signature and on-chain `initiate()` call.

However, `POST /orders/next-nonce` returns a **different sequential nonce** (e.g., `2`). If the backend expects the nonce from `/orders/next-nonce` rather than the Permit2 nonce, the order hash reconstruction would fail.

**Question for devs:** Does the backend reconstruct the order hash from the submitted fields and verify it against the on-chain `OrderInitiated` event? If so, does it use the `nonce` field from the request, and does it expect this to be the Permit2 nonce or the backend sequential nonce?

### 2. orderData format

We send `orderData` as the raw hex bytes returned by the settlement contract's `prepareCrossChainOrder()`. This is the ABI-encoded `PersistenceOrderData` struct:
```
inputToken (address) | inputAmount (uint256) | outputToken (address) | 
outputAmount (uint256) | recipient (address) | destinationChainId (uint32)
```

**Question:** Does the backend expect this in a different format (e.g., JSON, or without the `0x` prefix)?

### 3. Missing designatedSolverAddress

The API spec shows `designatedSolverAddress` as optional. We don't send it. The frontend might always include it (from the selected quote's solver). If the backend needs this to route the order to the correct solver, it would explain the failure.

**Question:** Should we include `designatedSolverAddress` from the quote response? What value — the `solverId` string or a wallet address from `/solvers/{solverId}/addresses`?

---

## Impact

- **Users lose access to funds for up to 2 hours** — tokens are locked on-chain but the solver never fills the order because the backend doesn't know about it.
- **After `fillDeadline` passes**, the user can call `claimRefund()` to recover their tokens, but this requires manual intervention.
- **This blocks any programmatic/API integration** with Persistence Interop — the on-chain flow works, but without backend registration, orders are never fulfilled.

---

## What We Need

1. **Backend error logs** for the 500 response when processing the submit-with-tx request above
2. **Clarification on the `nonce` field** — should it be the Permit2 nonce (from the contract) or the backend sequential nonce (from `/orders/next-nonce`)?
3. **A working example payload** for `submit-with-tx` that the backend accepts — ideally from the frontend's network tab
4. **Confirmation on whether `designatedSolverAddress` is truly optional** or effectively required

---

## Our Environment

- **Wallet:** `0x221726819bcfDDC3B05be56369a14ac836E64B7F`
- **Source chain:** Base (8453)
- **Destination chain:** BSC (56)
- **Token pair:** cbBTC → BTCB
- **Settlement contract:** `0x5e53703b62472c336D2d7963e789b911cFafFeA7`
- **Integration:** BridgeKitty MCP server (TypeScript, ethers v6)
