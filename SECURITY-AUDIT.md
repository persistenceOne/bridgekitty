# BridgeKitty Security Audit

**Date:** 2026-02-26
**Auditor:** Forge ⚒️ (Persistence Labs Security)
**Scope:** Full source review of `src/` (~6,767 lines TypeScript)
**Context:** Pre-publish npm audit — MCP server handling cross-chain crypto bridges with real money

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 3 |
| MEDIUM | 5 |
| LOW | 4 |
| INFO | 3 |
| **Total** | **17** |

**Overall Risk Assessment: HIGH — Do NOT publish without addressing CRITICAL and HIGH findings.**

The codebase shows strong awareness of security (amount caps, rate limiting, circuit breakers, verified token registry, transaction simulation, exact approvals). However, there are critical issues around private key exposure through MCP tool responses and wallet setup that must be fixed before public release.

---

## CRITICAL

### C-1: `wallet_setup` Returns Wallet Addresses But Writes Keys Insecurely
**File:** `src/tools/wallet.ts:37-103`
**Risk:** Complete loss of funds

The `wallet_setup` tool generates a mnemonic, derives keys for EVM/Cosmos/Solana, and writes them ALL to `.env` in the current working directory. Problems:

1. **CWD-dependent write** — `path.resolve(process.cwd(), ".env")` writes to whatever directory the MCP server is launched from. If launched from `/tmp` or a shared directory, keys are exposed.
2. **Overwrites existing .env** — `fs.writeFileSync` without checking if the file already exists. If a user already has `PRIVATE_KEY` set for a different wallet, it's silently overwritten with a new one, potentially stranding funds on the old key.
3. **Mnemonic + ALL private keys in one file** — A single file compromise exposes every chain. No encryption at rest.
4. **File permissions set to 0o600** — Good, but only on Unix. On Windows this is a no-op.

**Recommended Fix:**
- Check if `.env` already exists and refuse to overwrite (or require `--force`)
- Never write the mnemonic to disk — derive keys on-the-fly from the mnemonic, or use a proper keystore
- Consider encrypting the `.env` or using OS keychain integration
- At minimum, warn the user loudly about backing up and securing the file

### C-2: Private Key Loaded From Environment and Used Directly in MCP Tool Handler
**File:** `src/tools/execute-bridge.ts:66-68`, `src/tools/persistence-rewards.ts:68`
**Risk:** Key exfiltration by malicious MCP client

When `bridge_execute` is called with a Persistence backend quote, the server reads `process.env.PRIVATE_KEY` and signs+executes the transaction server-side. The MCP protocol is designed for untrusted clients — **any MCP client connected to this server can trigger transaction signing**.

A malicious MCP client can:
1. Request a quote for a Persistence route
2. Call `bridge_execute` with that quoteId
3. The server signs and sends the transaction using the stored private key

There is **no authorization, confirmation, or spending limit** on the `bridge_execute` tool when the Persistence backend is used. The amount caps (0.00005–0.001 BTC) in the Persistence backend provide some limit, but this is still ~$65 per transaction that any connected MCP client can trigger.

**Recommended Fix:**
- Remove server-side signing from the MCP flow entirely. MCP should only return unsigned transactions.
- If server-side signing is needed, require explicit user confirmation per transaction (out-of-band)
- At minimum, add a per-session spending limit and require re-authentication

---

## HIGH

### H-1: ACP Wallet Private Key in Environment Variables
**File:** `src/acp/types.ts:95`
**Risk:** Key exposure through environment variable enumeration

`ACP_AGENT_WALLET_PRIVATE_KEY` is loaded from env vars. In containerized environments (Docker, K8s), env vars may be logged, exposed via `/proc`, or visible to other processes. Combined with the `.env` auto-loading in `index.ts`, this means the ACP wallet key is always in process memory.

**Recommended Fix:**
- Use a secrets manager or encrypted keystore
- At minimum, document that this should never be set in Dockerfiles or CI configs
- Clear the env var after loading (`delete process.env.ACP_AGENT_WALLET_PRIVATE_KEY`)

### H-2: Permit2 Signature Replay Window
**File:** `src/backends/persistence.ts:216`
**Risk:** Signed EIP-712 data replayable for 10 minutes after failure

When `signAndExecute` fails at the `initiate()` step, the code revokes the ERC20→Permit2 approval (good). However, the comment acknowledges: *"the EIP-712 signature may be replayable until the deadline expires"*. The 10-minute `initiateDeadline` is reasonable but still a window where a front-runner or MEV bot could replay the signature if they observe it.

**Recommended Fix:**
- The 10-minute deadline is already a good mitigation (tightened from 1 hour per code comments)
- Consider using a shorter deadline (2-5 minutes) for the Permit2 signature
- Document this risk for users

### H-3: No Transaction Confirmation / Double-Spend Protection
**File:** `src/tools/execute-bridge.ts`, `src/backends/persistence.ts:189-267`
**Risk:** Race condition if `bridge_execute` called twice with same quoteId

If an MCP client calls `bridge_execute` twice quickly with the same `quoteId`, both calls will find the quote in cache, and both will attempt to execute. The Persistence backend's on-chain nonce should prevent double-execution, but for other backends, `buildTransaction` may return valid tx data both times, leading to:
- Double approval transactions (wasting gas)
- Potential double-spend if the backend doesn't deduplicate

**Recommended Fix:**
- Delete the quote from cache immediately when `bridge_execute` is called (before execution)
- Add a per-quoteId execution lock

---

## MEDIUM

### M-1: Error Messages May Leak Internal State
**File:** Multiple files (all `catch` blocks)
**Risk:** Information disclosure

Error messages from backends are passed through to MCP clients:
- `src/tools/execute-bridge.ts:89`: `Persistence execution failed: ${(err as Error).message}` — could contain RPC details, contract state
- `src/backends/persistence.ts:159`: `Persistence ${res.status}: ${text.slice(0, 200)}` — API error bodies may contain internal info
- `src/tools/wallet.ts:106`: `Setup failed: ${(err as Error).message}` — could expose filesystem paths

**Recommended Fix:**
- Sanitize error messages before returning to MCP clients
- Return generic errors with a correlation ID, log details server-side

### M-2: `wallet_setup` Sets Keys in `process.env` at Runtime
**File:** `src/tools/wallet.ts:84-87`
**Risk:** Key available to all code in the process

After generating keys, `wallet_setup` sets `process.env.PRIVATE_KEY`, `MNEMONIC`, and `SOLANA_PRIVATE_KEY`. These are then accessible to every module in the process, including any future dependencies. If a dependency is compromised (supply chain attack), it can read these values.

**Recommended Fix:**
- Store keys in a module-scoped variable rather than `process.env`
- Or better: don't store keys in memory at all — read from file only when needed

### M-3: No HTTPS Enforcement for RPC/API Calls
**File:** `src/utils/gas-estimator.ts`, `src/backends/*.ts`
**Risk:** MITM if someone misconfigures an RPC URL

RPC URLs from env vars (`RPC_ETHEREUM`, etc.) are used without validating they use HTTPS. A user could accidentally set `http://...` or an attacker could inject a non-HTTPS URL.

**Recommended Fix:**
- Validate that all RPC URLs start with `https://` (except localhost for development)

### M-4: Solana Key Derivation Fallback Creates Independent Keypair
**File:** `src/tools/wallet.ts:72-77`
**Risk:** User confusion, potential fund loss

If Solana key derivation fails (missing `ed25519-hd-key` dependency), the code silently falls back to generating an **independent** Solana keypair that is NOT derived from the mnemonic. The user is told "All wallets derived from a single mnemonic" but this may not be true. If they only back up the mnemonic, the Solana key is unrecoverable.

**Recommended Fix:**
- Fail loudly instead of falling back to an independent keypair
- Or clearly inform the user that the Solana wallet is independently generated

### M-5: Rate Limiting is Per-Route, Not Per-Client
**File:** `src/tools/get-quote.ts:17-47`
**Risk:** One malicious client can exhaust rate limits for all clients

Rate limiting is based on route key (chain+token combo), not per MCP client session. A malicious client hammering quotes for a popular route blocks all other clients on that route.

**Recommended Fix:**
- Add per-session/per-client rate limiting in addition to per-route limits

---

## LOW

### L-1: `.env` Not Checked for File Permissions on Load
**File:** `src/index.ts:25-38`
**Risk:** Keys readable by other users if permissions are wrong

The `loadDotEnv()` function reads `.env` without checking its file permissions. If the file was created with default permissions (0o644), other users on the system can read it.

**Recommended Fix:**
- Check file permissions on load and warn if too permissive (not 0o600)

### L-2: `console.error` / `console.log` Used for Logging
**File:** Throughout `src/backends/persistence.ts`, `src/utils/circuit-breaker.ts`
**Risk:** Sensitive data in logs

While no private keys are logged (verified: `grep` found no key/secret logging), operational details like transaction hashes, wallet addresses, and nonces are logged to stderr. In production, these logs could be collected and stored insecurely.

**Recommended Fix:**
- Use a structured logger with configurable log levels
- Ensure logs go to a controlled destination in production

### L-3: 17 Low-Severity npm Audit Vulnerabilities
**File:** `package.json` (transitive dependencies)
**Risk:** Known vulnerabilities in `@ethersproject/*` (ethers v5 via `@virtuals-protocol/acp-node`)

All 17 vulnerabilities are in the legacy ethers v5 packages pulled in transitively by the ACP SDK. These are low severity and in a transitive dependency, but should be tracked.

**Recommended Fix:**
- Track upstream: wait for `@virtuals-protocol/acp-node` to update to ethers v6
- Consider pinning or overriding if specific CVEs are concerning

### L-4: Hardcoded Fallback Gas Prices and Token Prices
**File:** `src/utils/gas-estimator.ts:47-68`
**Risk:** Stale prices could mislead users

Fallback prices (e.g., ETH = $1,850, BNB = $600) will become inaccurate over time. If live APIs fail and fallbacks are used, gas cost estimates could be significantly wrong.

**Recommended Fix:**
- Flag estimates using fallback prices more prominently to the user (already partially done with `usingFallbackPrices`)
- Consider removing exact dollar amounts and just showing "estimated" when using fallbacks

---

## INFO

### I-1: Good Practice — Exact Approvals
**File:** `src/tools/execute-bridge.ts:145-148`, `src/backends/persistence.ts:231`
**Risk:** None (positive finding)

Token approvals use exact amounts rather than `type(uint256).max`. The execute-bridge tool even includes a note: *"The approval is for the EXACT bridge amount only — not an unlimited approval."* This is the correct security practice.

### I-2: Good Practice — Verified Token Registry
**File:** `src/utils/token-registry.ts`
**Risk:** None (positive finding)

Token symbol resolution uses a hardcoded, curated registry of verified canonical addresses. Unknown symbols are rejected with clear errors rather than falling back to unverified sources. This prevents phishing via malicious token contracts.

### I-3: Good Practice — Transaction Simulation
**File:** `src/utils/tx-simulator.ts`
**Risk:** None (positive finding)

Transactions are simulated via `eth_estimateGas` before being returned to the user. Reverts are caught and reported. This prevents users from submitting transactions that would fail on-chain.

---

## Hardcoded Addresses Verification

| Address | Usage | Verified |
|---------|-------|----------|
| `0xb24aCFcda187135490d81517ab56709FdDe6a81A` | BridgeKitty fee wallet (Wallet 2) | ✅ Matches TOOLS.md |
| `0x5e53703b62472c336D2d7963e789b911cFafFeA7` | Persistence settlement contract | ✅ Protocol contract |
| `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Permit2 (Uniswap) | ✅ Canonical Permit2 address |
| `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | cbBTC on Base | ✅ Coinbase verified |
| `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` | BTCB on BSC | ✅ Binance verified |

No hardcoded private keys found. No test credentials in source. ✅

---

## Recommendations for Publishing

### Must Fix (blocking):
1. **C-2**: Remove server-side signing from MCP tool flow, or add strict authorization
2. **C-1**: Fix `wallet_setup` to not silently overwrite existing keys
3. **H-3**: Add quoteId execution locking to prevent double-execution

### Should Fix (high priority):
4. **H-1**: Clear sensitive env vars after loading
5. **M-2**: Don't store keys in `process.env` after loading
6. **M-4**: Fail instead of silently generating independent Solana keypair
7. **M-1**: Sanitize error messages before returning to MCP clients

### Nice to Have:
8. **M-3**: Validate HTTPS on RPC URLs
9. **M-5**: Per-client rate limiting
10. **L-1**: Check .env file permissions on load

---

*Audit complete. The codebase is well-structured with good security awareness overall. The critical issues are concentrated around private key management in the MCP flow — fix those and this is ready to ship.*
