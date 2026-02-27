import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { simulateTransaction } from "../utils/tx-simulator.js";
import { getChainName } from "../utils/chains.js";
import { sanitizeError } from "../utils/sanitize-error.js";

// H-3: Quote execution locking — prevent double-execution
const executingQuotes = new Set<string>();

/** Default timeout for buildTransaction API calls (ms) */
const BUILD_TX_TIMEOUT_MS = Number(process.env.BRIDGEKITTY_TX_TIMEOUT_MS) || 30_000;

/**
 * Race a promise against a timeout. Returns a clear error on timeout instead of hanging.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);
}

export function registerExecuteBridge(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_execute",
    "Get the transaction data to execute a bridge transfer. Returns unsigned transaction(s) for the agent to sign and send. Use a quoteId from bridge_get_quote for best results.",
    {
      quoteId: z
        .string()
        .describe("Quote ID from bridge_get_quote result"),
      slippage: z
        .number()
        .default(0.005)
        .describe("Max slippage tolerance (0.005 = 0.5%)"),
    },
    async (params) => {
      const quote = engine.getCachedQuote(params.quoteId);
      if (!quote) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Quote expired or not found. Please call bridge_get_quote again to get a fresh quote.",
            },
          ],
        };
      }

      const backend = engine.getBackend(quote.backendName);
      if (!backend) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Backend '${quote.backendName}' not available. Known backends: ${engine.getAllBackends().map((b) => b.name).join(", ")}`,
            },
          ],
        };
      }

      // H-3: Prevent double-execution of the same quote
      if (executingQuotes.has(params.quoteId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "This quote is already being executed. Please wait for the current execution to complete.",
            },
          ],
          isError: true,
        };
      }

      executingQuotes.add(params.quoteId);
      try {
        // MEDIUM-004: Pre-build expiry check — reject quotes that would expire during building
        const BUILD_TIMEOUT_MS = 15_000;
        if (quote.expiresAt && quote.expiresAt <= Date.now() + BUILD_TIMEOUT_MS) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Quote is about to expire (or already expired) and may not survive the build step. Please call bridge_get_quote again to get a fresh quote.",
              },
            ],
          };
        }

        const txRequest = await withTimeout(
          backend.buildTransaction(quote),
          BUILD_TX_TIMEOUT_MS,
          `buildTransaction (${backend.name})`
        );

        // Simulate the main transaction to verify it won't revert
        const warnings: string[] = [];
        const simulation = await simulateTransaction(txRequest.chainId, {
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value,
        });

        if (!simulation.success) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Transaction simulation failed",
                  message: simulation.error,
                  advice: "The transaction would likely revert on-chain. Please get a fresh quote and try again.",
                  provider: txRequest.provider,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        if (simulation.warning) {
          warnings.push(simulation.warning);
        }

        if (simulation.estimatedGas) {
          txRequest.gasLimit = txRequest.gasLimit ?? simulation.estimatedGas;
        }

        const response: Record<string, any> = {
          provider: txRequest.provider,
          trackingId: txRequest.trackingId,
          transaction: {
            to: txRequest.to,
            data: txRequest.data,
            value: txRequest.value,
            chainId: txRequest.chainId,
            ...(txRequest.gasLimit ? { gasLimit: txRequest.gasLimit } : {}),
          },
          instructions: "Sign and send this transaction to initiate the bridge transfer.",
        };

        if (txRequest.approvalTx) {
          response.approvalTransaction = {
            to: txRequest.approvalTx.to,
            data: txRequest.approvalTx.data,
            value: txRequest.approvalTx.value,
            chainId: txRequest.approvalTx.chainId,
          };
          if (txRequest.needsPostApprovalBuild) {
            response.instructions =
              "Two-phase execution needed: (1) Send the approvalTransaction first. (2) AFTER approval confirms, " +
              "call bridge_execute again with the same quoteId — the bridge tx will be re-fetched with the correct nonce.";
            response.needsPostApprovalBuild = true;
          } else {
            response.instructions =
              "Two transactions needed: (1) Send the approvalTransaction first to approve token spending (exact amount, not unlimited). (2) Then send the main transaction to initiate the bridge.";
          }
          response.approvalNote =
            "The approval is for the EXACT bridge amount only — not an unlimited approval. " +
            "This is safer but means you'll need a new approval for each bridge transaction.";
        }

        // Warn about native token requirements (e.g. deBridge protocol fees)
        if (txRequest.value && txRequest.value !== "0x0" && txRequest.value !== "0x00") {
          const valueBigInt = BigInt(txRequest.value);
          if (valueBigInt > 0n) {
            const ethAmount = Number(valueBigInt) / 1e18;
            const chainName = getChainName(txRequest.chainId) ?? `chain ${txRequest.chainId}`;
            const nativeSymbol = [56].includes(txRequest.chainId) ? "BNB"
              : [137].includes(txRequest.chainId) ? "MATIC"
              : [43114].includes(txRequest.chainId) ? "AVAX"
              : "ETH";
            warnings.push(
              `⚠️ This transaction requires ${ethAmount.toFixed(6)} ${nativeSymbol} for protocol fees in addition to the bridge amount. Ensure your wallet on ${chainName} has sufficient ${nativeSymbol} balance.`
            );
          }
        }

        if (warnings.length > 0) {
          response.warnings = warnings;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to build transaction: ${sanitizeError(err as Error)}`,
            },
          ],
        };
      } finally {
        // H-3: Always release the lock
        executingQuotes.delete(params.quoteId);
      }
    }
  );
}
