import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PersistenceBackend } from "../../src/backends/persistence.js";
import type { BridgeQuote } from "../../src/backends/types.js";

// Mock ethers to control contract calls
const mockEncodeFunctionData = vi.fn().mockReturnValue("0xmockcalldata");
const mockDecodeFunctionResult = vi.fn();
const mockCall = vi.fn();

vi.mock("ethers", async () => {
  const actual = await vi.importActual("ethers");

  // Need class-like constructors (new-able)
  function MockJsonRpcProvider() {
    return { call: mockCall };
  }
  function MockContract() {
    return {
      interface: {
        encodeFunctionData: mockEncodeFunctionData,
        decodeFunctionResult: mockDecodeFunctionResult,
      },
    };
  }
  function MockInterface() {
    return {
      encodeFunctionData: vi.fn().mockReturnValue("0xapprovaldata"),
    };
  }

  return {
    ...actual,
    ethers: {
      ...(actual as any).ethers,
      JsonRpcProvider: MockJsonRpcProvider,
      Contract: MockContract,
      Interface: MockInterface,
      zeroPadValue: (actual as any).ethers.zeroPadValue,
    },
  };
});

// Mock gas estimator
vi.mock("../../src/utils/gas-estimator.js", () => ({
  getGasUnits: () => 250_000,
  estimateGasCostUsd: async () => ({ costUsd: 0.10, usingFallbackPrices: false }),
}));

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SETTLEMENT_CONTRACT = "0x5e53703b62472c336D2d7963e789b911cFafFeA7";

function makeQuote(overrides?: Partial<BridgeQuote>): BridgeQuote {
  return {
    backendName: "persistence",
    provider: "Persistence Interop (direct)",
    outputAmount: "0.00009900",
    outputAmountRaw: "9900000000000000", // 18-decimal BTCB
    minOutputAmount: "0.00009851",
    minOutputAmountRaw: "9850500000000000", // 0.5% slippage applied
    outputDecimals: 18,
    estimatedGasCostUsd: 0.10,
    estimatedFeeUsd: 0.10,
    feeBreakdown: {
      gasCostUsd: 0.10,
      protocolFeeUsd: 0,
      integratorFeeUsd: 0,
      integratorFeePercent: null,
      totalFeeUsd: 0.10,
    },
    estimatedTimeSeconds: 120,
    route: "cbBTC → Persistence Solver → BTCB",
    quoteData: {
      id: "test-order-1",
      sourceChainId: 8453,
      destinationChainId: 56,
      sourceAmount: "10000", // 8-decimal cbBTC
      estimatedDestinationAmount: "9900000000000000", // 18-decimal BTCB
    },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("PersistenceBackend EIP-712 flow", () => {
  let backend: PersistenceBackend;

  beforeEach(() => {
    backend = new PersistenceBackend();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const CONTRACT_NONCE = 42n;
  const SWAPPER = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

  function setupContractMock() {
    const now = Math.floor(new Date("2026-01-15T12:00:00Z").getTime() / 1000);
    mockCall.mockResolvedValue("0xmockresult");
    mockDecodeFunctionResult.mockReturnValue([
      {
        settlementContract: SETTLEMENT_CONTRACT,
        swapper: SWAPPER,
        nonce: CONTRACT_NONCE,
        originChainId: 8453,
        initiateDeadline: now + 600,
        fillDeadline: now + 7200,
        orderData: "0xorderdata",
      },
    ]);
  }

  it("constructs correct EIP-712 domain (name=Permit2, correct chainId, verifyingContract)", async () => {
    setupContractMock();
    const prepared = await backend.prepareOrder(makeQuote(), SWAPPER);

    expect(prepared.eip712Domain).toEqual({
      name: "Permit2",
      chainId: 8453,
      verifyingContract: PERMIT2_ADDRESS,
    });
  });

  it("uses the contract-returned nonce (not backend nonce)", async () => {
    setupContractMock();
    const prepared = await backend.prepareOrder(makeQuote(), SWAPPER);

    expect(prepared.order.nonce).toBe(CONTRACT_NONCE);
    expect((prepared.eip712Value as any).nonce).toBe(CONTRACT_NONCE);
    expect((prepared.eip712Value as any).witness.nonce).toBe(CONTRACT_NONCE);
  });

  it("sets initiateDeadline to now + 180 seconds (3 min, H-2 tightened)", async () => {
    setupContractMock();
    const beforeCall = Math.floor(Date.now() / 1000);

    // The contract mock returns the deadline we set, but we need to verify
    // what prepareOrder passes TO the contract
    await backend.prepareOrder(makeQuote(), SWAPPER);

    const afterCall = Math.floor(Date.now() / 1000);

    // Verify the encodeFunctionData was called with initiateDeadline ≈ now + 180
    const callArgs = mockEncodeFunctionData.mock.calls[0];
    expect(callArgs[0]).toBe("prepareCrossChainOrder");
    const initiateDeadlineArg = Number(callArgs[1][6]); // 7th arg is initiateDeadline
    // Deadline should be between (beforeCall + 180) and (afterCall + 180), with small margin
    expect(initiateDeadlineArg).toBeGreaterThanOrEqual(beforeCall + 180 - 2);
    expect(initiateDeadlineArg).toBeLessThanOrEqual(afterCall + 180 + 2);
  });

  it("approval amount matches the input amount exactly", async () => {
    setupContractMock();
    const quote = makeQuote();
    const prepared = await backend.prepareOrder(quote, SWAPPER);

    // The approval tx should approve exactly the input amount
    expect(prepared.inputAmount).toBe("10000");
    expect(prepared.approvalTx.to).toBe(
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" // cbBTC on Base
    );
    // The eip712Value.permitted.amount should match
    expect((prepared.eip712Value as any).permitted.amount).toBe("10000");
  });

  it("uses minOutputAmountRaw (slippage-adjusted) for on-chain order output", async () => {
    setupContractMock();
    const quote = makeQuote();

    await backend.prepareOrder(quote, SWAPPER);

    // Verify the output amount passed to the contract is the slippage-adjusted amount
    const callArgs = mockEncodeFunctionData.mock.calls[0];
    const outputAmountArg = callArgs[1][3]; // 4th arg is outputAmount
    // Should be minOutputAmountRaw (9850500000000000) not raw (9900000000000000)
    expect(outputAmountArg).toBe("9850500000000000");
  });

  it("buildTransaction throws explaining signAndExecute is required", async () => {
    await expect(backend.buildTransaction(makeQuote())).rejects.toThrow(
      /signAndExecute/
    );
  });
});
