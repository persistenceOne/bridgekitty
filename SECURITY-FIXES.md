# Security Fixes Summary

Applied: 2026-02-26

## CRITICAL

### C-1: wallet_setup overwrites existing .env
- **File:** `src/tools/wallet.ts`
- **Fix:** Added pre-check: if `.env` exists and contains `PRIVATE_KEY`, tool returns an error telling user to delete it first. Added stronger backup warning in success response.

### C-2: Server-side signing in MCP flow
- **File:** `src/tools/execute-bridge.ts`
- **Fix:** Removed the entire Persistence `signAndExecute` code path from `bridge_execute`. Persistence backend now goes through `buildTransaction()` like all other backends (which throws explaining EIP-712 requirement). Server-side signing remains only in `persistence-rewards.ts` (opt-in reward farming tools).

## HIGH

### H-1: Clear env vars after loading / In-memory key store
- **File:** `src/tools/wallet.ts`
- **Fix:** Created module-scoped `keyStore` object and `getKey()` function. `wallet_setup` writes to keyStore (not `process.env`). All tools read via `getKey()` which falls back to `process.env` then clears the env var after reading. Exported `getKey` for use by other tool files.

### H-2: Permit2 deadline too long
- **File:** `src/backends/persistence.ts`
- **Fix:** Reduced `initiateDeadline` from 600 seconds (10 min) to 180 seconds (3 min).

### H-3: Quote execution locking
- **File:** `src/tools/execute-bridge.ts`
- **Fix:** Added `Set<string>` tracking executing quoteIds. Returns error if same quoteId is already executing. Cleaned up in `finally` block.

## MEDIUM

### M-1: Sanitize error messages
- **File:** `src/utils/sanitize-error.ts` (new)
- **Fix:** Created `sanitizeError()` utility that strips file paths, RPC URLs, hex data dumps, and stack traces. Applied across all tool files (`wallet.ts`, `execute-bridge.ts`, `persistence-rewards.ts`).

### M-2: Don't store keys in process.env
- Covered by H-1 above.

### M-3: Validate HTTPS on RPC URLs
- **File:** `src/utils/gas-estimator.ts`
- **Fix:** Added `validateRpcUrl()` that rejects `http://` URLs except `localhost` and `127.0.0.1`. Applied to `getChainRpcUrl()`.

### M-4: Solana silent fallback
- **File:** `src/tools/wallet.ts`
- **Fix:** Removed silent fallback that generated an independent Solana keypair. Now returns clear error telling user to `npm install ed25519-hd-key @scure/bip39`.

### M-5: Per-client rate limiting
- **Skipped** — MCP is single-client per server instance.

## LOW

### L-1: Check .env permissions on load
- **File:** `src/index.ts`
- **Fix:** After reading `.env`, checks if permissions are more permissive than `0600`. Logs warning to stderr if so.

### L-2: Structured logging
- **Skipped** — too much refactoring for pre-publish.

### L-4: Stale fallback prices
- **File:** `src/utils/gas-estimator.ts`
- **Fix:** Added comment noting fallback prices are stale data with last-updated date (2026-02-26).

## Verification
- ✅ `npm run build` — compiles clean
- ✅ Smoke test — LiFi quote returns successfully
