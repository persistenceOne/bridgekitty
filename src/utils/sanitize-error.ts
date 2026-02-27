/**
 * M-1: Sanitize error messages before returning to MCP clients.
 * Strips file paths, RPC URLs, and internal details.
 */
export function sanitizeError(err: Error): string {
  let msg = err.message || "Unknown error";

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

  // Truncate overly long messages
  if (msg.length > 300) {
    msg = msg.slice(0, 297) + "...";
  }

  return msg;
}
