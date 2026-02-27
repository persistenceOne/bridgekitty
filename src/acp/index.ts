/**
 * ACP Integration Module for BridgeKitty
 *
 * Integrates with Virtuals Protocol's Agent Commerce Protocol (ACP)
 * to accept bridge jobs from other AI agents.
 */

export { AcpListener } from "./listener.js";
export { handleBridgeJob, parseRequirement } from "./handler.js";
export { getBridgeKittyOffering, printRegistrationGuide } from "./registration.js";
export {
  loadAcpConfig,
  type AcpConfig,
  type AcpBridgeRequirement,
  type AcpDeliverable,
  type AcpDeliverableStatus,
  type AcpQuoteInfo,
  type AcpTransactionData,
  type AcpServiceOffering,
} from "./types.js";
