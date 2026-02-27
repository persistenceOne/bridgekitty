import { z } from "zod";
import { sanitizeError } from "../utils/sanitize-error.js";
export function registerCheckStatus(server, engine) {
    server.tool("bridge_status", "Check the status of a cross-chain bridge transfer. Provide the tracking ID from bridge_execute, or a transaction hash with provider name.", {
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
    }, async (params) => {
        // Validate: at least one of trackingId or txHash must be provided
        if (!params.trackingId && !params.txHash) {
            return {
                content: [
                    {
                        type: "text",
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
        if (!providerName)
            providerName = "lifi"; // default
        const backend = engine.getBackend(providerName);
        if (!backend) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown provider: ${providerName}. Available: ${engine.getAllBackends().map((b) => b.name).join(", ")}`,
                    },
                ],
            };
        }
        try {
            const meta = {};
            if (params.txHash)
                meta.txHash = params.txHash;
            if (params.fromChain)
                meta.fromChain = params.fromChain;
            if (params.toChain)
                meta.toChain = params.toChain;
            const status = await backend.getStatus(params.trackingId ?? params.txHash ?? "", meta);
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
                content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Status check failed: ${sanitizeError(err)}`,
                    },
                ],
                isError: true,
            };
        }
    });
}
