/**
 * Structured error format returned to agents.
 * Agents can switch on errorType for programmatic handling.
 */
export interface BridgeKittyError {
  errorType: string;
  message: string;
  chain?: string;
  retryAfterSeconds?: number;
  rpcProvider?: string;
  rpcRetries?: number;
}

/**
 * Detect and wrap upstream RPC rate-limit / tier-limit errors.
 * Returns a structured BridgeKittyError if detected, null otherwise.
 */
export function detectRpcError(err: Error, chainId?: number): BridgeKittyError | null {
  const msg = err.message || "";
  const lowerMsg = msg.toLowerCase();

  // Rate limit detection patterns
  if (
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("too many requests") ||
    lowerMsg.includes("429") ||
    lowerMsg.includes("upgrade your tier") ||
    lowerMsg.includes("please upgrade") ||
    lowerMsg.includes("capacity exceeded") ||
    lowerMsg.includes("request limit")
  ) {
    return {
      errorType: "rpc_rate_limit",
      message: "RPC rate limit reached. Retrying with a different provider.",
      chain: chainId ? `chain ${chainId}` : undefined,
      retryAfterSeconds: 5,
    };
  }

  // Timeout detection
  if (
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("timed out") ||
    lowerMsg.includes("etimedout") ||
    lowerMsg.includes("econnaborted")
  ) {
    return {
      errorType: "rpc_timeout",
      message: "RPC request timed out. Retrying with a different provider.",
      chain: chainId ? `chain ${chainId}` : undefined,
      retryAfterSeconds: 3,
    };
  }

  // Connection refused / network errors
  if (
    lowerMsg.includes("econnrefused") ||
    lowerMsg.includes("enotfound") ||
    lowerMsg.includes("network error") ||
    lowerMsg.includes("fetch failed")
  ) {
    return {
      errorType: "rpc_unavailable",
      message: "RPC provider is unavailable. Trying alternative provider.",
      chain: chainId ? `chain ${chainId}` : undefined,
      retryAfterSeconds: 2,
    };
  }

  // All RPCs exhausted
  if (
    lowerMsg.includes("all rpcs failed") ||
    lowerMsg.includes("no rpc available")
  ) {
    return {
      errorType: "rpc_exhausted",
      message: "All RPC providers failed. Please retry after a short delay.",
      chain: chainId ? `chain ${chainId}` : undefined,
      retryAfterSeconds: 15,
    };
  }

  return null;
}

/**
 * M-1: Sanitize error messages before returning to MCP clients.
 * Strips file paths, RPC URLs, and internal details.
 * Never passes through raw upstream error messages.
 */
export function sanitizeError(err: Error): string {
  let msg = err.message || "Unknown error";

  // First check for known RPC error patterns and return clean message
  const rpcError = detectRpcError(err);
  if (rpcError) {
    return rpcError.message;
  }

  // Strip file paths (Unix and Windows)
  msg = msg.replace(/\/[\w./-]+\.(ts|js|json|env)/g, "[path]");
  msg = msg.replace(/[A-Z]:\\[\w.\\-]+\.(ts|js|json|env)/gi, "[path]");

  // Strip RPC/HTTP URLs (but keep domain for context)
  msg = msg.replace(/https?:\/\/[^\s"',)]+/g, (url) => {
    try {
      const u = new URL(url);
      return `[${u.hostname}]`;
    } catch {
      return "[url]";
    }
  });

  // Strip stack traces
  msg = msg.replace(/\n\s+at\s+.*/g, "");

  // Strip hex data dumps (long hex strings > 20 chars)
  msg = msg.replace(/0x[a-fA-F0-9]{20,}/g, "[hex-data]");

  // Strip bare hex private keys (64 hex chars not prefixed with 0x)
  msg = msg.replace(/\b[a-fA-F0-9]{64}\b/g, "[key-redacted]");

  // Strip mnemonic phrases (sequences of 12+ lowercase words that look like BIP-39)
  msg = msg.replace(/\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, "[mnemonic-redacted]");

  // Strip base58 strings (Solana private keys are 44-88 base58 chars)
  msg = msg.replace(/[1-9A-HJ-NP-Za-km-z]{43,88}/g, "[key-redacted]");

  // Strip raw upstream "upgrade your tier" messages
  msg = msg.replace(/please upgrade[^.]*\./gi, "RPC provider rate limit reached.");

  // Truncate overly long messages
  if (msg.length > 300) {
    msg = msg.slice(0, 297) + "...";
  }

  return msg;
}
