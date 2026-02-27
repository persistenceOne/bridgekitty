/**
 * ACP Service Registration for BridgeKitty
 *
 * Defines the service offering schema that gets registered on the
 * Virtuals ACP platform. Registration itself is done via the ACP web UI
 * at https://app.virtuals.io/acp/join — this module provides the canonical
 * offering definition and helpers.
 */

import type { AcpServiceOffering } from "./types.js";

/**
 * The canonical BridgeKitty service offering definition.
 * This matches what should be configured in the ACP Agent Registry UI.
 */
export function getBridgeKittyOffering(priceUsd: number): AcpServiceOffering {
  return {
    name: "bridgekitty-bridge",
    description:
      "Cross-chain bridge quote and unsigned transaction data. " +
      "Aggregates LI.FI, deBridge, Across, Relay, and Persistence to find the best route. " +
      "Returns unsigned tx data — buyer agent handles signing and submission. " +
      "Supports 14+ EVM chains including Ethereum, Base, Arbitrum, Optimism, Polygon, BSC.",
    priceUsd,
    requirementSchema: {
      fromChain: "string — chain name or ID (e.g. 'ethereum', '1', 'base', '8453')",
      toChain: "string — destination chain name or ID",
      fromToken: "string — token symbol (e.g. 'USDC') or contract address (0x...)",
      toToken: "string — destination token symbol or contract address",
      amount: "string — human-readable amount (e.g. '100' for 100 USDC)",
      senderAddress: "string — the 0x address that will sign and send the tx",
      recipientAddress: "string (optional) — destination address, defaults to senderAddress",
    },
    deliverableSchema: {
      status: "string — 'success' | 'no_routes' | 'error'",
      quote: "object — { provider, youReceiveMin, estimatedGasFee, estimatedTime, route, quoteId }",
      transaction: "object — { to, data, value, chainId, gasLimit? } — the unsigned bridge tx",
      approvalTx: "object (optional) — { to, data, value, chainId } — token approval tx if needed",
      instructions: "string — human-readable steps for the agent",
      warnings: "string[] (optional) — security notes or caveats",
    },
  };
}

/**
 * Log the offering details for manual registration on the ACP platform.
 * Call this during setup to see what needs to be configured in the UI.
 */
export function printRegistrationGuide(priceUsd: number): void {
  const offering = getBridgeKittyOffering(priceUsd);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║        BridgeKitty ACP Service Registration Guide          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log("Register at: https://app.virtuals.io/acp/join\n");
  console.log(`Service Name: ${offering.name}`);
  console.log(`Price: $${offering.priceUsd} USD per job`);
  console.log(`\nDescription:\n${offering.description}\n`);
  console.log("Requirement Schema (configure in ACP UI):");
  console.log(JSON.stringify(offering.requirementSchema, null, 2));
  console.log("\nDeliverable Schema:");
  console.log(JSON.stringify(offering.deliverableSchema, null, 2));
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log("After registration, set ACP_AGENT_ENTITY_ID in .env.acp");
  console.log("────────────────────────────────────────────────────────────────\n");
}
