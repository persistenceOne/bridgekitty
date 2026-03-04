import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { sanitizeError } from "../utils/sanitize-error.js";

export function registerCheckStatus(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "bridge_status",
    "Check the status of a cross-chain bridge transfer. " +
    "Supports all providers: LI.FI, Squid Router, deBridge, Across, Relay, Persistence Interop. " +
    "Provide the tracking ID from bridge_execute, or a transaction hash with provider name. " +
    "Returns: status (pending/in_progress/completed/failed), source/destination tx hashes, elapsed time, and estimated remaining time.",
    {
      trackingId: z
        .string()
        .optional()
        .describe("Tracking ID from bridge_execute"),
      txHash: z
        .string()
        .optional()
        .describe("Source chain transaction hash"),
      fromChain: z
        .string()
        .optional()
        .describe("Source chain ID (needed with txHash for LI.FI)"),
      toChain: z
        .string()
        .optional()
        .describe("Destination chain ID (needed with txHash for LI.FI)"),
      provider: z
        .string()
        .optional()
        .describe("Bridge provider (e.g. 'lifi', 'persistence')"),
    },
    async (params) => {
      // Validate: at least one of trackingId or txHash must be provided
      if (!params.trackingId && !params.txHash) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Please provide either a trackingId (from bridge_execute) or a txHash to check bridge status.",
            },
          ],
          isError: true,
        };
      }

      // Determine which backend to query
      let providerName = params.provider;
      if (!providerName && params.trackingId) {
        providerName = params.trackingId.split(":")[0];
      }
      if (!providerName) providerName = "lifi"; // default

      const backend = engine.getBackend(providerName);
      if (!backend) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown provider: ${providerName}. Available: ${engine.getAllBackends().map((b) => b.name).join(", ")}`,
            },
          ],
        };
      }

      try {
        const meta: Record<string, string> = {};
        if (params.txHash) meta.txHash = params.txHash;
        if (params.fromChain) meta.fromChain = params.fromChain;
        if (params.toChain) meta.toChain = params.toChain;

        const status = await backend.getStatus(
          params.trackingId ?? params.txHash ?? "",
          meta
        );

        const response = {
          status: status.state,
          summary: status.humanReadable,
          provider: status.provider,
          sourceTx: status.sourceTxHash ?? null,
          destinationTx: status.destTxHash ?? null,
          elapsedSeconds: status.elapsed,
          estimatedRemainingSeconds: status.estimatedRemaining ?? null,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Status check failed: ${sanitizeError(err as Error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
