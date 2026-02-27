#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LiFiBackend } from "./backends/lifi.js";
import { PersistenceBackend } from "./backends/persistence.js";
import { DeBridgeBackend } from "./backends/debridge.js";
import { RelayBackend } from "./backends/relay.js";
import { AcrossBackend } from "./backends/across.js";
import { SkipBackend } from "./backends/skip.js";
import { RoutingEngine } from "./routing/engine.js";
import { CircuitBreaker } from "./utils/circuit-breaker.js";
import { registerGetQuote } from "./tools/get-quote.js";
import { registerExecuteBridge } from "./tools/execute-bridge.js";
import { registerCheckStatus } from "./tools/check-status.js";
import { registerGetChains } from "./tools/get-chains.js";
import { registerGetTokens } from "./tools/get-tokens.js";
import { registerXprtFarmTools } from "./tools/xprt-farm.js";
import { registerWalletTools, getKey } from "./tools/wallet.js";
import * as fs from "fs";
import * as path from "path";

// Auto-load .env from CWD
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  // L-1: Warn if .env permissions are too permissive
  try {
    const stat = fs.statSync(envPath);
    const mode = stat.mode & 0o777;
    if (mode > 0o600) {
      console.error(
        `⚠️  WARNING: .env file has permissive permissions (${mode.toString(8)}). ` +
        `Recommended: chmod 600 .env (currently readable by group/others).`
      );
    }
  } catch { /* stat failed — non-fatal */ }

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

// MEDIUM-002: Immediately move sensitive keys from process.env to in-memory store.
// loadDotEnv puts everything into process.env; calling getKey() moves them to the
// in-memory keyStore and deletes from process.env, minimizing the exposure window.
getKey("privateKey");
getKey("mnemonic");
getKey("solanaKey");

// ─── BridgeKitty fee configuration (hardcoded — not user-configurable) ────────
// These are the BridgeKitty project's integrator/affiliate addresses.
// Revenue from bridge fees funds ongoing development.
// Persistence Interop routes are always fee-free (direct protocol integration).
const BRIDGEKITTY_FEE_WALLET = "0xb24aCFcda187135490d81517ab56709FdDe6a81A";
const BRIDGEKITTY_DEBRIDGE_FEE = "0.1"; // 0.1% affiliate fee
const BRIDGEKITTY_LIFI_FEE = undefined as string | undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_LIFI_INTEGRATOR = undefined as string | undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_RELAY_FEE = "10"; // 10 bps = 0.1% app fee

function createEngine(): RoutingEngine {
  const lifi = new LiFiBackend(
    process.env.LIFI_API_KEY,
    BRIDGEKITTY_LIFI_INTEGRATOR,
    BRIDGEKITTY_LIFI_FEE
  );
  const persistence = new PersistenceBackend();
  const debridge = new DeBridgeBackend(
    BRIDGEKITTY_DEBRIDGE_FEE,
    BRIDGEKITTY_FEE_WALLET
  );
  const relay = new RelayBackend(
    BRIDGEKITTY_FEE_WALLET,
    BRIDGEKITTY_RELAY_FEE
  );
  const across = new AcrossBackend(
    BRIDGEKITTY_FEE_WALLET
  );
  const skip = new SkipBackend(process.env.SKIP_API_KEY);

  const circuitBreaker = new CircuitBreaker();
  return new RoutingEngine([lifi, persistence, debridge, relay, across, skip], circuitBreaker);
}

async function main() {
  const engine = createEngine();

  const server = new McpServer({
    name: "bridgekitty",
    version: "0.1.0",
  });

  registerGetQuote(server, engine);
  registerExecuteBridge(server, engine);
  registerCheckStatus(server, engine);
  registerGetChains(server, engine);
  registerGetTokens(server, engine);
  registerWalletTools(server);
  registerXprtFarmTools(server, engine);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BridgeKitty 🐱 MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
