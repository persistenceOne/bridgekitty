#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LiFiBackend } from "./backends/lifi.js";
import { PersistenceBackend } from "./backends/persistence.js";
import { DeBridgeBackend } from "./backends/debridge.js";
import { RelayBackend } from "./backends/relay.js";
import { AcrossBackend } from "./backends/across.js";
import { RoutingEngine } from "./routing/engine.js";
import { registerGetQuote } from "./tools/get-quote.js";
import { registerExecuteBridge } from "./tools/execute-bridge.js";
import { registerCheckStatus } from "./tools/check-status.js";
import { registerGetChains } from "./tools/get-chains.js";
import { registerGetTokens } from "./tools/get-tokens.js";

// Initialize backends
const lifi = new LiFiBackend(
  process.env.LIFI_API_KEY,
  process.env.LIFI_INTEGRATOR,
  process.env.LIFI_FEE
);
const persistence = new PersistenceBackend();
const debridge = new DeBridgeBackend();
const relay = new RelayBackend();
const across = new AcrossBackend();

// Initialize routing engine
const engine = new RoutingEngine([lifi, persistence, debridge, relay, across]);

// Create MCP server
const server = new McpServer({
  name: "bridgekitty",
  version: "0.1.0",
});

// Register all tools
registerGetQuote(server, engine);
registerExecuteBridge(server, engine);
registerCheckStatus(server, engine);
registerGetChains(server, engine);
registerGetTokens(server, engine);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BridgeKitty 🐱 MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
