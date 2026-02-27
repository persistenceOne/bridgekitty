#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LiFiBackend } from "./backends/lifi.js";
import { PersistenceBackend } from "./backends/persistence.js";
import { DeBridgeBackend } from "./backends/debridge.js";
import { RelayBackend } from "./backends/relay.js";
import { AcrossBackend } from "./backends/across.js";
import { SquidBackend } from "./backends/squid.js";
import { RoutingEngine } from "./routing/engine.js";
import { CircuitBreaker } from "./utils/circuit-breaker.js";
import { registerGetQuote } from "./tools/get-quote.js";
import { registerExecuteBridge } from "./tools/execute-bridge.js";
import { registerCheckStatus } from "./tools/check-status.js";
import { registerGetChains } from "./tools/get-chains.js";
import { registerGetTokens } from "./tools/get-tokens.js";
import { registerPersistenceEarnTools } from "./tools/persistence-rewards.js";
import { registerWalletTools } from "./tools/wallet.js";
import * as fs from "fs";
import * as path from "path";
// Auto-load .env from CWD
function loadDotEnv() {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath))
        return;
    // L-1: Warn if .env permissions are too permissive
    try {
        const stat = fs.statSync(envPath);
        const mode = stat.mode & 0o777;
        if (mode > 0o600) {
            console.error(`⚠️  WARNING: .env file has permissive permissions (${mode.toString(8)}). ` +
                `Recommended: chmod 600 .env (currently readable by group/others).`);
        }
    }
    catch { /* stat failed — non-fatal */ }
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1)
            continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}
loadDotEnv();
/**
 * Create the shared routing engine (used by both MCP and ACP modes).
 */
// ─── BridgeKitty fee configuration (hardcoded — not user-configurable) ────────
// These are the BridgeKitty project's integrator/affiliate addresses.
// Revenue from bridge fees funds ongoing development.
// Persistence Interop routes are always fee-free (direct protocol integration).
const BRIDGEKITTY_FEE_WALLET = "0xb24aCFcda187135490d81517ab56709FdDe6a81A";
const BRIDGEKITTY_DEBRIDGE_FEE = "0.1"; // 0.1% affiliate fee
const BRIDGEKITTY_LIFI_FEE = undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_LIFI_INTEGRATOR = undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_RELAY_FEE = "10"; // 10 bps = 0.1% app fee
function createEngine() {
    // Initialize backends with hardcoded BridgeKitty fee config
    const lifi = new LiFiBackend(process.env.LIFI_API_KEY, // user can provide their own LI.FI API key for higher rate limits
    BRIDGEKITTY_LIFI_INTEGRATOR, BRIDGEKITTY_LIFI_FEE);
    const persistence = new PersistenceBackend();
    const debridge = new DeBridgeBackend(BRIDGEKITTY_DEBRIDGE_FEE, BRIDGEKITTY_FEE_WALLET);
    const relay = new RelayBackend(BRIDGEKITTY_FEE_WALLET, BRIDGEKITTY_RELAY_FEE);
    const across = new AcrossBackend(BRIDGEKITTY_FEE_WALLET);
    const squid = new SquidBackend();
    const circuitBreaker = new CircuitBreaker();
    return new RoutingEngine([lifi, persistence, debridge, relay, across, squid], circuitBreaker);
}
/**
 * Start MCP stdio server (default mode).
 */
async function startMcpServer(engine) {
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
    registerPersistenceEarnTools(server, engine);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("BridgeKitty 🐱 MCP server running on stdio");
}
/**
 * Start ACP listener mode.
 */
async function startAcpListener(engine) {
    // Dynamic import to avoid loading ACP SDK in MCP mode
    const { AcpListener, loadAcpConfig, printRegistrationGuide } = await import("./acp/index.js");
    const config = loadAcpConfig();
    printRegistrationGuide(config.servicePriceUsd);
    const listener = new AcpListener(config, engine);
    // Graceful shutdown
    const shutdown = async () => {
        await listener.shutdown();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await listener.start();
}
// ─── CLI Entry Point ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args.includes("--acp") ? "acp"
    : args.includes("--register") ? "register"
        : "mcp";
async function main() {
    const engine = createEngine();
    switch (mode) {
        case "acp":
            await startAcpListener(engine);
            break;
        case "register": {
            const { printRegistrationGuide } = await import("./acp/index.js");
            const priceUsd = parseFloat(process.env.ACP_SERVICE_PRICE_USD ?? "0.20");
            printRegistrationGuide(priceUsd);
            break;
        }
        default:
            await startMcpServer(engine);
            break;
    }
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
