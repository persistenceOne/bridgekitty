import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";

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

      const backend = engine.getBackend(quote.provider);
      if (!backend) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Backend '${quote.provider}' not available.`,
            },
          ],
        };
      }

      try {
        const txRequest = await backend.buildTransaction(quote);

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
          response.instructions =
            "Two transactions needed: (1) Send the approvalTransaction first to approve token spending. (2) Then send the main transaction to initiate the bridge.";
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to build transaction: ${(err as Error).message}`,
            },
          ],
        };
      }
    }
  );
}
