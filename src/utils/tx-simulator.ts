/**
 * Transaction simulation via eth_estimateGas.
 * Verifies transactions won't revert before returning them to the user.
 */

import { getChainRpcUrl } from "./gas-estimator.js";

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
 *
 * If RPC is unavailable, returns a warning rather than blocking the transaction.
 */
export async function simulateTransaction(
  chainId: number,
  tx: { to: string; data: string; value: string; from?: string },
): Promise<SimulationResult> {
  const rpcUrl = getChainRpcUrl(chainId);
  if (!rpcUrl) {
    console.warn(
      `[tx-simulator] MEDIUM-003: Simulation bypassed — no RPC configured for chainId=${chainId}. ` +
      `Transaction will proceed without pre-flight simulation.`,
    );
    return {
      success: true,
      warning: `No RPC configured for chain ${chainId} — could not simulate. Proceed with caution.`,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIMULATION_TIMEOUT_MS);

    // Build the eth_estimateGas params
    const txParam: Record<string, string> = {
      to: tx.to,
      data: tx.data,
    };

    // Handle value — normalize to hex
    if (tx.value && tx.value !== "0x0" && tx.value !== "0x00") {
      txParam.value = tx.value.startsWith("0x") ? tx.value : `0x${BigInt(tx.value).toString(16)}`;
    }

    // Use a generic sender if none provided
    if (tx.from) {
      txParam.from = tx.from;
    }

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_estimateGas",
        params: [txParam],
        id: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        success: true,
        warning: `RPC returned ${res.status} during simulation — could not verify. Proceed with caution.`,
      };
    }

    const data = await res.json();

    if (data.error) {
      // Parse the revert reason if available
      const errorMsg = data.error.message ?? JSON.stringify(data.error);

      // Common revert patterns
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

      // Insufficient funds is expected (we're simulating without the user's actual balance)
      if (
        errorMsg.includes("insufficient funds") ||
        errorMsg.includes("insufficient balance")
      ) {
        return {
          success: true,
          warning: "Could not fully simulate (insufficient balance in simulation) — transaction structure appears valid.",
        };
      }

      // Other errors
      return {
        success: true,
        warning: `Simulation inconclusive: ${errorMsg.slice(0, 200)}. Proceed with caution.`,
      };
    }

    if (data.result) {
      return {
        success: true,
        estimatedGas: data.result,
      };
    }

    return {
      success: true,
      warning: "Simulation returned no result — could not verify. Proceed with caution.",
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes("abort")) {
      return {
        success: true,
        warning: "Simulation timed out — could not verify. Proceed with caution.",
      };
    }
    return {
      success: true,
      warning: `Simulation failed: ${errMsg.slice(0, 200)}. Proceed with caution.`,
    };
  }
}
