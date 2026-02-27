/**
 * sanitize-error — pure unit tests.
 * Tests that sensitive data is properly stripped from error messages.
 */
import { describe, it, expect } from "vitest";
import { sanitizeError } from "../../src/utils/sanitize-error.js";

describe("sanitizeError", () => {
  // ─── File paths ────────────────────────────────────────────────────

  it("strips Unix file paths", () => {
    const err = new Error("Failed at /home/user/projects/bridgekitty/src/index.ts:42");
    expect(sanitizeError(err)).toContain("[path]");
    expect(sanitizeError(err)).not.toContain("/home/user");
  });

  it("strips Windows file paths", () => {
    const err = new Error("Failed at C:\\Users\\dev\\bridgekitty\\src\\index.ts");
    expect(sanitizeError(err)).toContain("[path]");
    expect(sanitizeError(err)).not.toContain("C:\\Users");
  });

  it("strips .env file paths", () => {
    const err = new Error("Cannot read /home/user/.env");
    expect(sanitizeError(err)).toContain("[path]");
    expect(sanitizeError(err)).not.toContain("/home/user/.env");
  });

  it("strips .json file paths", () => {
    const err = new Error("Config error in /app/config/settings.json");
    expect(sanitizeError(err)).toContain("[path]");
    expect(sanitizeError(err)).not.toContain("/app/config");
  });

  // ─── URLs / RPC endpoints ─────────────────────────────────────────

  it("strips HTTP URLs but keeps hostname", () => {
    const err = new Error("Request to https://rpc.ankr.com/eth/v1/abc123 failed");
    const result = sanitizeError(err);
    expect(result).toContain("[rpc.ankr.com]");
    expect(result).not.toContain("abc123");
  });

  it("strips RPC URLs with API keys in path", () => {
    const err = new Error("RPC error at https://mainnet.infura.io/v3/my-secret-api-key");
    const result = sanitizeError(err);
    expect(result).toContain("[mainnet.infura.io]");
    expect(result).not.toContain("my-secret-api-key");
  });

  it("handles malformed URLs gracefully", () => {
    const err = new Error("Error: http://not a valid url here");
    const result = sanitizeError(err);
    // Should not crash
    expect(result).toBeTruthy();
  });

  // ─── Stack traces ─────────────────────────────────────────────────

  it("strips stack traces", () => {
    const err = new Error("Something failed");
    // Simulate a stack trace in the message
    err.message = "Something failed\n    at Object.<anonymous> (/app/src/index.ts:42:5)\n    at Module._compile (node:internal/modules/cjs/loader:1376:14)";
    const result = sanitizeError(err);
    expect(result).not.toContain("at Object.");
    expect(result).not.toContain("at Module._compile");
    expect(result).toContain("Something failed");
  });

  // ─── Hex data (transaction data, addresses) ───────────────────────

  it("strips long hex data (>20 chars)", () => {
    const err = new Error("Transaction 0xabcdef1234567890abcdef1234567890abcdef12 failed with data 0x0a0b0c0d0e0f1a1b1c1d1e1f2a2b2c2d2e2f3a3b3c3d3e3f");
    const result = sanitizeError(err);
    expect(result).toContain("[hex-data]");
  });

  it("does not strip short hex values", () => {
    const err = new Error("Gas: 0x1234");
    const result = sanitizeError(err);
    expect(result).toContain("0x1234");
  });

  // ─── Private keys (bare hex, 64 chars) ────────────────────────────

  it("strips bare hex private keys (64 hex chars)", () => {
    const fakeKey = "a".repeat(64);
    const err = new Error(`Key is ${fakeKey}`);
    const result = sanitizeError(err);
    expect(result).toContain("[key-redacted]");
    expect(result).not.toContain(fakeKey);
  });

  it("strips mixed-case hex private keys", () => {
    const fakeKey = "aB1c2D3e4F5678901234567890abcdef1234567890ABCDEF1234567890abcdef";
    const err = new Error(`Private key: ${fakeKey}`);
    const result = sanitizeError(err);
    expect(result).toContain("[key-redacted]");
    expect(result).not.toContain(fakeKey);
  });

  // ─── Mnemonic phrases ─────────────────────────────────────────────

  it("strips 12-word mnemonic phrases", () => {
    const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const err = new Error(`Mnemonic: ${mnemonic}`);
    const result = sanitizeError(err);
    expect(result).toContain("[mnemonic-redacted]");
    expect(result).not.toContain("abandon ability");
  });

  it("strips 24-word mnemonic phrases", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident arena armor arrow audit assist attract bacon badge ball bamboo banner barrel";
    const err = new Error(`Seed: ${words}`);
    const result = sanitizeError(err);
    expect(result).toContain("[mnemonic-redacted]");
    expect(result).not.toContain("abandon ability");
  });

  it("does not strip short word sequences (< 12 words)", () => {
    const err = new Error("The quick brown fox jumps over");
    const result = sanitizeError(err);
    // Should NOT be redacted — only 6 words
    expect(result).not.toContain("[mnemonic-redacted]");
  });

  // ─── Base58 (Solana private keys) ─────────────────────────────────

  it("strips base58 strings that look like Solana keys (44+ chars)", () => {
    // A realistic-looking base58 string (Solana key length)
    const fakeBase58 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi7Y8Nz3gHxR5tgmHnfBvqN";
    const err = new Error(`Solana key: ${fakeBase58}`);
    const result = sanitizeError(err);
    expect(result).toContain("[key-redacted]");
    expect(result).not.toContain(fakeBase58);
  });

  it("does not strip short base58 strings (< 43 chars)", () => {
    const shortStr = "3J98t1WpEZ73CNmQviecrny";
    const err = new Error(`Address: ${shortStr}`);
    const result = sanitizeError(err);
    expect(result).toContain(shortStr);
  });

  // ─── Message truncation ───────────────────────────────────────────

  it("truncates messages longer than 300 chars", () => {
    // Use a message that won't be caught by other sanitization patterns
    // (avoid hex-like chars, avoid base58 patterns, avoid word sequences)
    const longMsg = "Error: " + "something went wrong. ".repeat(20);
    const err = new Error(longMsg);
    const result = sanitizeError(err);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toMatch(/\.\.\.$/);
  });

  it("does not truncate short messages", () => {
    const err = new Error("Short error");
    const result = sanitizeError(err);
    expect(result).toBe("Short error");
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  it("handles error with no message", () => {
    const err = new Error();
    err.message = "";
    const result = sanitizeError(err);
    expect(result).toBe("Unknown error");
  });

  it("handles multiple sensitive items in one message", () => {
    const err = new Error(
      "Failed at /home/user/app.ts with key aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344 calling https://secret.rpc.io/v3/key123"
    );
    const result = sanitizeError(err);
    expect(result).toContain("[path]");
    expect(result).toContain("[key-redacted]");
    expect(result).toContain("[secret.rpc.io]");
    expect(result).not.toContain("/home/user");
    expect(result).not.toContain("key123");
  });

  it("preserves the core error meaning after sanitization", () => {
    const err = new Error("Transaction reverted: insufficient balance for transfer");
    const result = sanitizeError(err);
    expect(result).toContain("Transaction reverted");
    expect(result).toContain("insufficient balance");
  });
});
