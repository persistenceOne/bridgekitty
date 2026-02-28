/**
 * Transaction simulation via eth_estimateGas.
 * Verifies transactions won't revert before returning them to the user.
 * Uses multi-RPC failover for reliability.
 */

import { getChainRpcUrls } from "./gas-estimator.js";

const SIMULATION_TIMEOUT_MS = 8_000;

export interface SimulationResult {
  success: boolean;
  /** Estimated gas units if simulation succeeded */
  estimatedGas?: string;
  /** Error message if simulation failed */
  error?: string;
  /** Warning message for non-fatal issues */
  warning?: string;
}

/**
 * Simulate a transaction via eth_estimateGas.
 * Returns success/failure with gas estimate or error details.
 * Tries multiple RPCs with failover for reliability.
 *
 * If all RPCs are unavailable, returns a warning rather than blocking the transaction.
 */
export async function simulateTransaction(
  chainId: number,
  tx: { to: string; data: string; value: string; from?: string },
): Promise<SimulationResult> {
  const rpcUrls = getChainRpcUrls(chainId);
  if (rpcUrls.length === 0) {
    console.warn(
      `[tx-simulator] MEDIUM-003: Simulation bypassed — no RPC configured for chainId=${chainId}. ` +
      `Transaction will proceed without pre-flight simulation.`,
    );
    return {
      success: true,
      warning: `No RPC configured for chain ${chainId} — could not simulate. Proceed with caution.`,
    };
  }

  // Build the eth_estimateGas params (reused across RPC attempts)
  const txParam: Record<string, string> = {
    to: tx.to,
    data: tx.data,
  };
  if (tx.value && tx.value !== "0x0" && tx.value !== "0x00") {
    txParam.value = tx.value.startsWith("0x") ? tx.value : `0x${BigInt(tx.value).toString(16)}`;
  }
  if (tx.from) {
    txParam.from = tx.from;
  }

  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_estimateGas",
    params: [txParam],
    id: 1,
  });

  // Try each RPC in order — return first definitive result
  let lastWarning: string | undefined;
  for (const rpcUrl of rpcUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIMULATION_TIMEOUT_MS);

      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        lastWarning = `RPC returned ${res.status} during simulation`;
        continue; // Try next RPC
      }

      const data = await res.json();

      if (data.error) {
        const errorMsg = data.error.message ?? JSON.stringify(data.error);

        // Definitive revert — don't try other RPCs
        if (
          errorMsg.includes("execution reverted") ||
          errorMsg.includes("revert") ||
          errorMsg.includes("UNPREDICTABLE_GAS_LIMIT")
        ) {
          return {
            success: false,
            error: `Transaction would revert: ${errorMsg.slice(0, 300)}`,
          };
        }

        // Insufficient funds is expected (simulating without user's actual balance)
        if (
          errorMsg.includes("insufficient funds") ||
          errorMsg.includes("insufficient balance")
        ) {
          return {
            success: true,
            warning: "Could not fully simulate (insufficient balance in simulation) — transaction structure appears valid.",
          };
        }

        // Other RPC-specific errors — try next RPC
        lastWarning = `Simulation inconclusive: ${errorMsg.slice(0, 200)}`;
        continue;
      }

      if (data.result) {
        return {
          success: true,
          estimatedGas: data.result,
        };
      }

      lastWarning = "Simulation returned no result";
      continue;
    } catch (err) {
      const errMsg = (err as Error).message;
      lastWarning = errMsg.includes("abort")
        ? "Simulation timed out"
        : `Simulation failed: ${errMsg.slice(0, 200)}`;
      continue; // Try next RPC
    }
  }

  // All RPCs exhausted without a definitive result
  return {
    success: true,
    warning: `${lastWarning ?? "All RPCs failed"} (tried ${rpcUrls.length} RPCs). Proceed with caution.`,
  };
}
