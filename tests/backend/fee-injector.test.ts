import { describe, it, expect } from "vitest";
import { createBackendsWithFees } from "../../backend/src/services/fee-injector.js";
import type { FeeConfig } from "../../backend/src/services/fee-injector.js";

const BASE_CONFIG: FeeConfig = {
  feeRecipient: "0xb24aCFcda187135490d81517ab56709FdDe6a81A",
};

describe("createBackendsWithFees", () => {
  it("creates all 6 backends", () => {
    const backends = createBackendsWithFees(BASE_CONFIG);
    expect(backends).toHaveLength(6);

    const names = backends.map((b) => b.name);
    expect(names).toContain("lifi");
    expect(names).toContain("persistence");
    expect(names).toContain("debridge");
    expect(names).toContain("relay");
    expect(names).toContain("across");
    expect(names).toContain("squid");
  });

  it("each backend implements required interface methods", () => {
    const backends = createBackendsWithFees(BASE_CONFIG);
    for (const b of backends) {
      expect(typeof b.getQuote).toBe("function");
      expect(typeof b.buildTransaction).toBe("function");
      expect(typeof b.getStatus).toBe("function");
      expect(typeof b.getSupportedChains).toBe("function");
      expect(typeof b.name).toBe("string");
    }
  });

  it("creates backends with optional API keys", () => {
    const cfg: FeeConfig = {
      feeRecipient: "0xb24aCFcda187135490d81517ab56709FdDe6a81A",
      lifiApiKey: "test-lifi-key",
      lifiIntegrator: "test-integrator",
      lifiFeeBps: "30",
      debridgeFeePercent: "0.1",
      relayFeeBps: "30",
      squidIntegratorId: "test-squid-id",
    };
    const backends = createBackendsWithFees(cfg);
    expect(backends).toHaveLength(6);
  });

  it("creates backends without optional keys (no errors)", () => {
    const cfg: FeeConfig = { feeRecipient: "0xb24aCFcda187135490d81517ab56709FdDe6a81A" };
    expect(() => createBackendsWithFees(cfg)).not.toThrow();
  });

  it("fee recipient is never exposed to clients via backend names", () => {
    const backends = createBackendsWithFees(BASE_CONFIG);
    for (const b of backends) {
      // Backend names should not contain the fee wallet address
      expect(b.name).not.toContain("0xb24a");
    }
  });
});
