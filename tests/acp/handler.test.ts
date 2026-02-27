/**
 * Tests for ACP Job Handler
 *
 * Tests the handler's ability to:
 * - Parse and validate requirements
 * - Route through the RoutingEngine
 * - Build deliverables with quote + transaction data
 * - Handle error cases (bad input, no routes, timeouts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBridgeJob, parseRequirement } from "../../src/acp/handler.js";
import type { AcpBridgeRequirement } from "../../src/acp/types.js";
import type { RoutingEngine, CachedQuote } from "../../src/routing/engine.js";
import type { BridgeBackend, BridgeQuote, TransactionRequest } from "../../src/backends/types.js";
import { BackendValidationError } from "../../src/backends/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeQuote(overrides: Partial<BridgeQuote & { quoteId: string }> = {}): CachedQuote {
  return {
    backendName: "lifi",
    provider: "Stargate via LI.FI",
    outputAmount: "99.85",
    outputAmountRaw: "99850000",
    minOutputAmount: "99.50",
    minOutputAmountRaw: "99500000",
    estimatedGasCostUsd: 0.12,
    estimatedFeeUsd: 0.15,
    feeBreakdown: {
      gasCostUsd: 0.12,
      protocolFeeUsd: 0.03,
      integratorFeeUsd: 0,
      integratorFeePercent: null,
      totalFeeUsd: 0.15,
    },
    estimatedTimeSeconds: 45,
    route: "USDC → Stargate → USDC",
    quoteData: {},
    expiresAt: Date.now() + 60_000,
    quoteId: "test-quote-123",
    ...overrides,
  };
}

function makeTxRequest(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  return {
    to: "0x1234567890abcdef1234567890abcdef12345678",
    data: "0xabcdef",
    value: "0",
    chainId: 1,
    provider: "Stargate via LI.FI",
    trackingId: "track-123",
    ...overrides,
  };
}

function makeMockEngine(quotes: CachedQuote[] = [], txRequest?: TransactionRequest): RoutingEngine {
  const mockBackend: BridgeBackend = {
    name: "lifi",
    getQuote: vi.fn().mockResolvedValue(null),
    buildTransaction: vi.fn().mockResolvedValue(txRequest ?? makeTxRequest()),
    getStatus: vi.fn().mockResolvedValue({ state: "unknown", humanReadable: "", provider: "lifi", elapsed: 0 }),
    getSupportedChains: vi.fn().mockResolvedValue([]),
  };

  return {
    getQuotes: vi.fn().mockResolvedValue(quotes),
    getCachedQuote: vi.fn().mockReturnValue(quotes[0] ?? null),
    getBackend: vi.fn().mockReturnValue(mockBackend),
    getAllBackends: vi.fn().mockReturnValue([mockBackend]),
    getCircuitBreaker: vi.fn(),
    getLastRequestDiagnosis: vi.fn().mockReturnValue({
      allErrored: false,
      allEmpty: true,
      circuitBroken: [],
    }),
  } as unknown as RoutingEngine;
}

const validRequirement: AcpBridgeRequirement = {
  fromChain: "ethereum",
  toChain: "base",
  fromToken: "USDC",
  toToken: "USDC",
  amount: "100",
  senderAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
};

// ─── parseRequirement Tests ──────────────────────────────────────────────────

describe("parseRequirement", () => {
  it("parses valid requirement", () => {
    const result = parseRequirement({
      fromChain: "ethereum",
      toChain: "base",
      fromToken: "USDC",
      toToken: "USDC",
      amount: "100",
      senderAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    });

    expect(result.fromChain).toBe("ethereum");
    expect(result.toChain).toBe("base");
    expect(result.fromToken).toBe("USDC");
    expect(result.toToken).toBe("USDC");
    expect(result.amount).toBe("100");
    expect(result.senderAddress).toBe("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");
    expect(result.recipientAddress).toBeUndefined();
  });

  it("parses requirement with recipientAddress", () => {
    const result = parseRequirement({
      ...validRequirement,
      recipientAddress: "0xABCD1234567890ABCDEF1234567890ABCDEF1234",
    });
    expect(result.recipientAddress).toBe("0xABCD1234567890ABCDEF1234567890ABCDEF1234");
  });

  it("throws on null input", () => {
    expect(() => parseRequirement(null)).toThrow("must be a JSON object");
  });

  it("throws on string input", () => {
    expect(() => parseRequirement("hello")).toThrow("must be a JSON object");
  });

  it("throws on missing fromChain", () => {
    expect(() =>
      parseRequirement({ ...validRequirement, fromChain: undefined })
    ).toThrow("fromChain");
  });

  it("throws on missing toChain", () => {
    expect(() =>
      parseRequirement({ ...validRequirement, toChain: undefined })
    ).toThrow("toChain");
  });

  it("throws on missing fromToken", () => {
    expect(() =>
      parseRequirement({ ...validRequirement, fromToken: undefined })
    ).toThrow("fromToken");
  });

  it("throws on missing amount", () => {
    expect(() =>
      parseRequirement({ ...validRequirement, amount: undefined })
    ).toThrow("amount");
  });

  it("throws on missing senderAddress", () => {
    expect(() =>
      parseRequirement({ ...validRequirement, senderAddress: undefined })
    ).toThrow("senderAddress");
  });
});

// ─── handleBridgeJob Tests ───────────────────────────────────────────────────

describe("handleBridgeJob", () => {
  it("returns success with quote and transaction", async () => {
    const quote = makeQuote();
    const txReq = makeTxRequest();
    const engine = makeMockEngine([quote], txReq);

    const result = await handleBridgeJob(engine, validRequirement);

    expect(result.status).toBe("success");
    expect(result.quote).toBeDefined();
    expect(result.quote!.provider).toBe("Stargate via LI.FI");
    expect(result.quote!.youReceiveMin).toContain("99.50");
    expect(result.transaction).toBeDefined();
    expect(result.transaction!.to).toBe(txReq.to);
    expect(result.transaction!.data).toBe(txReq.data);
    expect(result.transaction!.chainId).toBe(1);
  });

  it("includes approval tx when present", async () => {
    const quote = makeQuote();
    const txReq = makeTxRequest({
      approvalTx: {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        data: "0xapprove",
        value: "0",
        chainId: 1,
      },
    });
    const engine = makeMockEngine([quote], txReq);

    const result = await handleBridgeJob(engine, validRequirement);

    expect(result.status).toBe("success");
    expect(result.approvalTx).toBeDefined();
    expect(result.approvalTx!.to).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(result.instructions).toContain("Two transactions");
  });

  it("returns error for unknown source chain", async () => {
    const engine = makeMockEngine();
    const result = await handleBridgeJob(engine, {
      ...validRequirement,
      fromChain: "fakenet",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Unknown source chain");
  });

  it("returns error for unknown destination chain", async () => {
    const engine = makeMockEngine();
    const result = await handleBridgeJob(engine, {
      ...validRequirement,
      toChain: "fakenet",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Unknown destination chain");
  });

  it("returns error for invalid amount", async () => {
    const engine = makeMockEngine();
    const result = await handleBridgeJob(engine, {
      ...validRequirement,
      amount: "not-a-number",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Invalid amount");
  });

  it("returns no_routes when no quotes found", async () => {
    const engine = makeMockEngine([]);

    const result = await handleBridgeJob(engine, validRequirement);

    expect(result.status).toBe("no_routes");
    expect(result.error).toContain("No bridge routes");
  });

  it("returns error when all backends are down", async () => {
    const engine = makeMockEngine([]);
    vi.mocked(engine.getLastRequestDiagnosis).mockReturnValue({
      allErrored: true,
      allEmpty: false,
      circuitBroken: ["lifi"],
    });

    const result = await handleBridgeJob(engine, validRequirement);

    expect(result.status).toBe("error");
    expect(result.error).toContain("unavailable");
  });

  it("returns error when routing engine throws validation error", async () => {
    const engine = makeMockEngine();
    vi.mocked(engine.getQuotes).mockRejectedValue(
      new BackendValidationError("Same chain bridging not supported")
    );

    const result = await handleBridgeJob(engine, validRequirement);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Same chain bridging");
  });

  it("handles buildTransaction failure gracefully", async () => {
    const quote = makeQuote();
    const engine = makeMockEngine([quote]);
    const backend = engine.getBackend("lifi")!;
    vi.mocked(backend.buildTransaction).mockRejectedValue(new Error("API timeout"));

    const result = await handleBridgeJob(engine, validRequirement);

    // Should still return success with quote, but indicate tx build failed
    expect(result.status).toBe("success");
    expect(result.quote).toBeDefined();
    expect(result.instructions).toContain("transaction build failed");
  });
});

// ─── Error Sanitization Tests ────────────────────────────────────────────────

describe("handleBridgeJob — Error Sanitization", () => {
  it("returns generic error message when backend throws unexpectedly", async () => {
    const engine = makeMockEngine();
    // Make getQuotes throw a non-validation error (simulating backend crash)
    vi.mocked(engine.getQuotes).mockRejectedValue(new Error("upstream API returned: {\"secret\":\"key123\"}"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleBridgeJob(engine, validRequirement);

    // The returned error should be generic — NOT containing backend details
    expect(result.status).toBe("error");
    expect(result.error).toBe("Bridge quote failed. Please try again later.");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("key123");
    expect(result.error).not.toContain("upstream API");

    // Full error SHOULD be logged server-side
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[acp-handler]"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("logs the full error to console.error", async () => {
    const engine = makeMockEngine();
    vi.mocked(engine.getQuotes).mockRejectedValue(new Error("detailed backend failure info"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleBridgeJob(engine, validRequirement);

    // Verify full error details are logged
    const loggedError = errorSpy.mock.calls.find(call =>
      typeof call[0] === "string" && call[0].includes("[acp-handler]")
    );
    expect(loggedError).toBeDefined();
    expect((loggedError![1] as Error).message).toBe("detailed backend failure info");

    errorSpy.mockRestore();
  });
});

// ─── Wallet Generation Tests ─────────────────────────────────────────────────

describe("wallet generation", () => {
  it("generates valid ethereum wallets via ethers", async () => {
    const { ethers } = await import("ethers");
    const wallet = ethers.Wallet.createRandom();

    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
