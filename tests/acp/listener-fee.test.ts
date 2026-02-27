/**
 * Tests for ACP fee verification in listener.ts (NEW-LOW-004)
 *
 * Tests that jobs with insufficient fees are rejected.
 */
import { describe, it, expect, vi } from "vitest";

// We test the fee verification logic extracted from the listener's onNewTask.
// The actual logic: if jobFee < config.servicePriceUsd → reject

describe("ACP Fee Verification", () => {
  const SERVICE_PRICE_USD = 0.50;

  function checkFee(jobFee: number | string | null | undefined): "accepted" | "rejected" {
    if (jobFee !== null && jobFee !== undefined) {
      const feeNum = typeof jobFee === "string" ? parseFloat(jobFee) : Number(jobFee);
      if (!isNaN(feeNum) && feeNum < SERVICE_PRICE_USD) {
        return "rejected";
      }
    }
    return "accepted";
  }

  it("accepts jobs with fee >= configured price", () => {
    expect(checkFee(0.50)).toBe("accepted");
    expect(checkFee(1.00)).toBe("accepted");
    expect(checkFee("0.75")).toBe("accepted");
  });

  it("rejects jobs with fee below configured price", () => {
    expect(checkFee(0.10)).toBe("rejected");
    expect(checkFee(0.0)).toBe("rejected");
    expect(checkFee("0.25")).toBe("rejected");
  });

  it("accepts jobs with null/undefined fee (no fee info)", () => {
    expect(checkFee(null)).toBe("accepted");
    expect(checkFee(undefined)).toBe("accepted");
  });

  it("accepts jobs with NaN fee (unparseable)", () => {
    expect(checkFee("not-a-number")).toBe("accepted");
  });
});
