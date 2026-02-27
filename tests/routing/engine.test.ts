import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoutingEngine } from "../../src/routing/engine.js";
import type { BridgeBackend, BridgeQuote, QuoteParams } from "../../src/backends/types.js";
import { BackendValidationError } from "../../src/backends/types.js";

// Helper to create a mock backend
function mockBackend(
  name: string,
  quoteFn: (params: QuoteParams) => Promise<BridgeQuote | null>
): BridgeBackend {
  return {
    name,
    getQuote: quoteFn,
    buildTransaction: vi.fn(),
    getStatus: vi.fn(),
    getSupportedChains: vi.fn().mockResolvedValue([]),
  };
}

// Helper to create a valid quote
function makeQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  const outputAmountRaw = overrides.outputAmountRaw ?? "100000000";
  // Derive human-readable amount from raw (assumes 6 decimals like USDC)
  const outputAmount = overrides.outputAmount ?? (Number(BigInt(outputAmountRaw)) / 1e6).toString();
  return {
    backendName: "test",
    provider: "Test Backend",
    outputAmount,
    outputAmountRaw,
    minOutputAmount: overrides.minOutputAmount ?? outputAmount,
    minOutputAmountRaw: overrides.minOutputAmountRaw ?? outputAmountRaw,
    estimatedGasCostUsd: 0.5,
    estimatedFeeUsd: 1.0,
    feeBreakdown: {
      gasCostUsd: 0.5,
      protocolFeeUsd: 0.5,
      integratorFeeUsd: 0,
      integratorFeePercent: null,
      totalFeeUsd: 1.0,
    },
    estimatedTimeSeconds: 60,
    route: "TEST → Bridge → TEST",
    quoteData: {},
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

// Valid quote params
const validParams: QuoteParams = {
  fromChainId: 1,
  toChainId: 8453,
  fromTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "100000000",
  fromAddress: "0x1234567890123456789012345678901234567890",
  preference: "cheapest",
};

describe("RoutingEngine — Input Validation", () => {
  let engine: RoutingEngine;

  beforeEach(() => {
    engine = new RoutingEngine([
      mockBackend("test", async () => makeQuote()),
    ]);
  });

  it("rejects invalid source chain ID", async () => {
    await expect(
      engine.getQuotes({ ...validParams, fromChainId: 0 })
    ).rejects.toThrow(BackendValidationError);
    await expect(
      engine.getQuotes({ ...validParams, fromChainId: -1 })
    ).rejects.toThrow(/Invalid source chain ID/);
  });

  it("rejects invalid destination chain ID", async () => {
    await expect(
      engine.getQuotes({ ...validParams, toChainId: 0 })
    ).rejects.toThrow(BackendValidationError);
  });

  it("rejects same source and destination chain", async () => {
    await expect(
      engine.getQuotes({ ...validParams, fromChainId: 1, toChainId: 1 })
    ).rejects.toThrow(/same/i);
  });

  it("rejects zero amount", async () => {
    await expect(
      engine.getQuotes({ ...validParams, amountRaw: "0" })
    ).rejects.toThrow(/positive/i);
  });

  it("rejects negative amount", async () => {
    await expect(
      engine.getQuotes({ ...validParams, amountRaw: "-100" })
    ).rejects.toThrow(BackendValidationError);
  });

  it("rejects non-numeric amount", async () => {
    await expect(
      engine.getQuotes({ ...validParams, amountRaw: "abc" })
    ).rejects.toThrow(/not a valid number/i);
  });

  it("rejects invalid sender address", async () => {
    await expect(
      engine.getQuotes({ ...validParams, fromAddress: "notanaddress" })
    ).rejects.toThrow(/Invalid sender address/);
  });

  it("rejects invalid recipient address", async () => {
    await expect(
      engine.getQuotes({ ...validParams, toAddress: "bad" })
    ).rejects.toThrow(/Invalid recipient address/);
  });

  it("rejects invalid token address", async () => {
    await expect(
      engine.getQuotes({ ...validParams, fromTokenAddress: "USDC" })
    ).rejects.toThrow(/Invalid source token address/);
  });

  it("accepts valid params", async () => {
    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBeGreaterThan(0);
  });
});

describe("RoutingEngine — Expired Quote Filtering", () => {
  it("filters out expired quotes", async () => {
    const engine = new RoutingEngine([
      mockBackend("expired", async () =>
        makeQuote({ backendName: "expired", expiresAt: Date.now() - 10_000 }) // already expired
      ),
      mockBackend("valid", async () =>
        makeQuote({ backendName: "valid", expiresAt: Date.now() + 120_000 })
      ),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(1);
    expect(quotes[0].backendName).toBe("valid");
  });

  it("filters quotes expiring within buffer window", async () => {
    const engine = new RoutingEngine([
      mockBackend("soon", async () =>
        makeQuote({ backendName: "soon", expiresAt: Date.now() + 2_000 }) // within 5s buffer
      ),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(0);
  });

  it("keeps quotes with sufficient time remaining", async () => {
    const engine = new RoutingEngine([
      mockBackend("good", async () =>
        makeQuote({ backendName: "good", expiresAt: Date.now() + 60_000 })
      ),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(1);
  });
});

describe("RoutingEngine — Backend Error Handling", () => {
  it("gracefully handles one backend failing", async () => {
    const engine = new RoutingEngine([
      mockBackend("failing", async () => {
        throw new Error("API down");
      }),
      mockBackend("working", async () =>
        makeQuote({ backendName: "working", outputAmountRaw: "50000000" })
      ),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(1);
    expect(quotes[0].backendName).toBe("working");
  });

  it("returns empty array when all backends fail", async () => {
    const engine = new RoutingEngine([
      mockBackend("fail1", async () => { throw new Error("down"); }),
      mockBackend("fail2", async () => { throw new Error("down"); }),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(0);
  });

  it("returns empty array when all backends return null", async () => {
    const engine = new RoutingEngine([
      mockBackend("null1", async () => null),
      mockBackend("null2", async () => null),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(0);
  });

  it("propagates BackendValidationError from backends", async () => {
    const engine = new RoutingEngine([
      mockBackend("validator", async () => {
        throw new BackendValidationError("Amount too small");
      }),
    ]);

    await expect(engine.getQuotes(validParams)).rejects.toThrow(
      BackendValidationError
    );
  });

  it("handles mixed success/failure/null", async () => {
    const engine = new RoutingEngine([
      mockBackend("ok", async () =>
        makeQuote({ backendName: "ok", outputAmountRaw: "100000000" })
      ),
      mockBackend("fail", async () => { throw new Error("down"); }),
      mockBackend("null", async () => null),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(1);
    expect(quotes[0].backendName).toBe("ok");
  });
});

describe("RoutingEngine — Sorting", () => {
  it("sorts by output amount (cheapest preference)", async () => {
    const engine = new RoutingEngine([
      mockBackend("low", async () =>
        makeQuote({ backendName: "low", outputAmountRaw: "90000000" })
      ),
      mockBackend("high", async () =>
        makeQuote({ backendName: "high", outputAmountRaw: "110000000" })
      ),
      mockBackend("mid", async () =>
        makeQuote({ backendName: "mid", outputAmountRaw: "100000000" })
      ),
    ]);

    const quotes = await engine.getQuotes({ ...validParams, preference: "cheapest" });
    expect(quotes[0].backendName).toBe("high");
    expect(quotes[1].backendName).toBe("mid");
    expect(quotes[2].backendName).toBe("low");
  });

  it("sorts by time (fastest preference)", async () => {
    const engine = new RoutingEngine([
      mockBackend("slow", async () =>
        makeQuote({ backendName: "slow", estimatedTimeSeconds: 300 })
      ),
      mockBackend("fast", async () =>
        makeQuote({ backendName: "fast", estimatedTimeSeconds: 10 })
      ),
      mockBackend("med", async () =>
        makeQuote({ backendName: "med", estimatedTimeSeconds: 60 })
      ),
    ]);

    const quotes = await engine.getQuotes({ ...validParams, preference: "fastest" });
    expect(quotes[0].backendName).toBe("fast");
    expect(quotes[1].backendName).toBe("med");
    expect(quotes[2].backendName).toBe("slow");
  });
});

describe("RoutingEngine — Cheapest Sort with Decimal Normalization", () => {
  it("ranks quotes with different outputDecimals correctly", async () => {
    const engine = new RoutingEngine([
      // 99.5 USDC (6 decimals) = raw 99500000
      mockBackend("usdc6", async () =>
        makeQuote({
          backendName: "usdc6",
          outputAmountRaw: "99500000",
          minOutputAmountRaw: "99500000",
          outputDecimals: 6,
        })
      ),
      // 99.0 token (18 decimals) = raw 99000000000000000000
      mockBackend("token18", async () =>
        makeQuote({
          backendName: "token18",
          outputAmountRaw: "99000000000000000000",
          minOutputAmountRaw: "99000000000000000000",
          outputDecimals: 18,
        })
      ),
    ]);

    const quotes = await engine.getQuotes({ ...validParams, preference: "cheapest" });
    // 99.5 > 99.0, so usdc6 should be first
    expect(quotes[0].backendName).toBe("usdc6");
    expect(quotes[1].backendName).toBe("token18");
  });

  it("99.5 USDC (6 dec) beats 99.0 (18 dec)", async () => {
    const engine = new RoutingEngine([
      mockBackend("low18", async () =>
        makeQuote({
          backendName: "low18",
          outputAmountRaw: "99000000000000000000",
          minOutputAmountRaw: "99000000000000000000",
          outputDecimals: 18,
        })
      ),
      mockBackend("high6", async () =>
        makeQuote({
          backendName: "high6",
          outputAmountRaw: "99500000",
          minOutputAmountRaw: "99500000",
          outputDecimals: 6,
        })
      ),
    ]);

    const quotes = await engine.getQuotes({ ...validParams, preference: "cheapest" });
    expect(quotes[0].backendName).toBe("high6");
  });

  it("equal-value quotes with different decimals tie properly", async () => {
    const engine = new RoutingEngine([
      mockBackend("a6", async () =>
        makeQuote({
          backendName: "a6",
          outputAmountRaw: "100000000", // 100 with 6 decimals
          minOutputAmountRaw: "100000000",
          outputDecimals: 6,
          estimatedGasCostUsd: 1.0,
        })
      ),
      mockBackend("b18", async () =>
        makeQuote({
          backendName: "b18",
          outputAmountRaw: "100000000000000000000", // 100 with 18 decimals
          minOutputAmountRaw: "100000000000000000000",
          outputDecimals: 18,
          estimatedGasCostUsd: 0.5, // lower gas = wins tiebreaker
        })
      ),
    ]);

    const quotes = await engine.getQuotes({ ...validParams, preference: "cheapest" });
    // Equal value, so gas tiebreaker: b18 has lower gas
    expect(quotes[0].backendName).toBe("b18");
  });
});

describe("RoutingEngine — Quote Caching", () => {
  it("assigns unique quoteIds", async () => {
    const engine = new RoutingEngine([
      mockBackend("a", async () => makeQuote({ backendName: "a" })),
      mockBackend("b", async () => makeQuote({ backendName: "b" })),
    ]);

    const quotes = await engine.getQuotes(validParams);
    expect(quotes.length).toBe(2);
    expect(quotes[0].quoteId).not.toBe(quotes[1].quoteId);
  });

  it("retrieves cached quote by ID", async () => {
    const engine = new RoutingEngine([
      mockBackend("test", async () => makeQuote()),
    ]);

    const quotes = await engine.getQuotes(validParams);
    const cached = engine.getCachedQuote(quotes[0].quoteId);
    expect(cached).not.toBeNull();
    expect(cached!.backendName).toBe("test");
  });

  it("returns null for expired cached quote", async () => {
    const engine = new RoutingEngine([
      mockBackend("test", async () =>
        makeQuote({ expiresAt: Date.now() + 10_000 }) // valid long enough to pass filter
      ),
    ]);

    const quotes = await engine.getQuotes(validParams);
    const quoteId = quotes[0].quoteId;

    // Manually expire it in the cache
    // @ts-expect-error accessing private field for test
    const entry = engine.quoteCache.get(quoteId);
    if (entry) entry.expiresAt = Date.now() - 1;

    expect(engine.getCachedQuote(quoteId)).toBeNull();
  });

  it("returns null for unknown quoteId", () => {
    const engine = new RoutingEngine([]);
    expect(engine.getCachedQuote("nonexistent-id")).toBeNull();
  });
});

describe("RoutingEngine — Backend Lookup", () => {
  it("finds backend by name", () => {
    const engine = new RoutingEngine([
      mockBackend("lifi", async () => null),
      mockBackend("debridge", async () => null),
    ]);

    expect(engine.getBackend("lifi")).toBeDefined();
    expect(engine.getBackend("debridge")).toBeDefined();
    expect(engine.getBackend("unknown")).toBeUndefined();
  });

  it("lists all backends", () => {
    const engine = new RoutingEngine([
      mockBackend("a", async () => null),
      mockBackend("b", async () => null),
    ]);

    expect(engine.getAllBackends().length).toBe(2);
  });
});

describe("RoutingEngine — getQuotes with multi-route backend", () => {
  it("uses getQuotes method when available", async () => {
    const multiBackend: BridgeBackend = {
      name: "multi",
      getQuote: vi.fn(),
      getQuotes: vi.fn().mockResolvedValue([
        makeQuote({ backendName: "multi", outputAmountRaw: "100000000", provider: "Route A" }),
        makeQuote({ backendName: "multi", outputAmountRaw: "95000000", provider: "Route B" }),
      ]),
      buildTransaction: vi.fn(),
      getStatus: vi.fn(),
      getSupportedChains: vi.fn().mockResolvedValue([]),
    };

    const engine = new RoutingEngine([multiBackend]);
    const quotes = await engine.getQuotes(validParams);

    expect(quotes.length).toBe(2);
    expect(multiBackend.getQuotes).toHaveBeenCalled();
    expect(multiBackend.getQuote).not.toHaveBeenCalled();
  });

  it("falls back to getQuote when getQuotes not available", async () => {
    const singleBackend: BridgeBackend = {
      name: "single",
      getQuote: vi.fn().mockResolvedValue(makeQuote({ backendName: "single" })),
      buildTransaction: vi.fn(),
      getStatus: vi.fn(),
      getSupportedChains: vi.fn().mockResolvedValue([]),
    };

    const engine = new RoutingEngine([singleBackend]);
    const quotes = await engine.getQuotes(validParams);

    expect(quotes.length).toBe(1);
    expect(singleBackend.getQuote).toHaveBeenCalled();
  });
});
