import { LiFiBackend } from "../../../src/backends/lifi.js";
import { DeBridgeBackend } from "../../../src/backends/debridge.js";
import { RelayBackend } from "../../../src/backends/relay.js";
import { AcrossBackend } from "../../../src/backends/across.js";
import { SquidBackend } from "../../../src/backends/squid.js";
import { PersistenceBackend } from "../../../src/backends/persistence.js";
import type { BridgeBackend } from "../../../src/backends/types.js";
import { config } from "../config.js";

export interface FeeConfig {
  feeRecipient: string;
  lifiApiKey?: string;
  lifiIntegrator?: string;
  lifiFeeBps?: string;
  debridgeFeePercent?: string;
  relayFeeBps?: string;
  squidIntegratorId?: string;
}

/**
 * Create all bridge backend instances with server-side fee configuration injected.
 * Keys and fee settings are sourced from environment variables, never from the client.
 */
export function createBackendsWithFees(cfg: FeeConfig = loadFeeConfig()): BridgeBackend[] {
  const lifi = new LiFiBackend(cfg.lifiApiKey, cfg.lifiIntegrator, cfg.lifiFeeBps);
  const persistence = new PersistenceBackend();
  const debridge = new DeBridgeBackend(cfg.debridgeFeePercent, cfg.feeRecipient);
  const relay = new RelayBackend(cfg.feeRecipient, cfg.relayFeeBps);
  const across = new AcrossBackend(cfg.feeRecipient);
  const squid = new SquidBackend(cfg.squidIntegratorId);

  return [lifi, persistence, debridge, relay, across, squid];
}

/**
 * Load fee configuration from the global config (env vars).
 */
export function loadFeeConfig(): FeeConfig {
  return {
    feeRecipient: config.feeRecipientAddress,
    lifiApiKey: config.lifi.apiKey,
    lifiIntegrator: config.lifi.integrator,
    lifiFeeBps: config.lifi.feeBps,
    debridgeFeePercent: config.debridge.affiliateFeePercent,
    relayFeeBps: config.relay.feeBps,
    squidIntegratorId: config.squid.integratorId,
  };
}
