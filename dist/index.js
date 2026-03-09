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
import { registerXprtFarmTools } from "./tools/xprt-farm.js";
import { registerWalletTools, getKey, getConfigDir } from "./tools/wallet.js";
import { registerHelpTool } from "./tools/help.js";
import { registerXprtRewardsCheck } from "./tools/xprt-rewards.js";
import { registerMultiQuote } from "./tools/multi-quote.js";
import { registerOnboardTool } from "./tools/onboard.js";
import { registerXprtStakingTools } from "./tools/xprt-staking.js";
import * as fs from "fs";
import * as path from "path";
// Auto-load .env from stable config directory (~/.bridgekitty/ or BRIDGEKITTY_HOME)
function loadDotEnv() {
    const envPath = path.resolve(getConfigDir(), ".env");
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
// Migration hint: if old CWD-based .env exists but config dir one doesn't, warn user
try {
    const oldEnvPath = path.resolve(process.cwd(), ".env");
    const newEnvPath = path.resolve(getConfigDir(), ".env");
    if (oldEnvPath !== newEnvPath && fs.existsSync(oldEnvPath) && !fs.existsSync(newEnvPath)) {
        const oldContent = fs.readFileSync(oldEnvPath, "utf-8");
        if (oldContent.includes("PRIVATE_KEY")) {
            console.error(`⚠️  Found .env with PRIVATE_KEY at ${oldEnvPath} (old CWD-based location). ` +
                `BridgeKitty now uses ${path.resolve(getConfigDir(), ".env")}. ` +
                `Move your .env: mv "${oldEnvPath}" "${newEnvPath}"`);
        }
    }
}
catch { /* non-fatal */ }
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
const BRIDGEKITTY_DEBRIDGE_FEE = undefined; // disabled for now
const BRIDGEKITTY_LIFI_FEE = undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_LIFI_INTEGRATOR = undefined; // needs portal.li.fi registration first
const BRIDGEKITTY_RELAY_FEE = undefined; // disabled for now
function createEngine() {
    const lifi = new LiFiBackend(process.env.LIFI_API_KEY, BRIDGEKITTY_LIFI_INTEGRATOR, BRIDGEKITTY_LIFI_FEE);
    const persistence = new PersistenceBackend();
    const debridge = new DeBridgeBackend(BRIDGEKITTY_DEBRIDGE_FEE, BRIDGEKITTY_FEE_WALLET);
    const relay = new RelayBackend(BRIDGEKITTY_FEE_WALLET, BRIDGEKITTY_RELAY_FEE);
    const across = new AcrossBackend(BRIDGEKITTY_FEE_WALLET);
    const squid = new SquidBackend(process.env.SQUID_INTEGRATOR_ID);
    const circuitBreaker = new CircuitBreaker();
    return new RoutingEngine([lifi, persistence, debridge, relay, across, squid], circuitBreaker);
}
// Read version from package.json to avoid duplication
const PKG_VERSION = (() => {
    try {
        const pkgPath = new URL("../package.json", import.meta.url);
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "0.1.0";
    }
    catch {
        return "0.1.0";
    }
})();
async function main() {
    // TTY detection: if run directly in a terminal (not piped), show help and exit.
    // MCP servers communicate over stdio JSON-RPC — running in a TTY means the user
    // probably ran `npx bridgekitty` directly instead of configuring it as an MCP server.
    if (process.stdin.isTTY && !process.argv.includes("--stdio")) {
        console.log(`BridgeKitty 🐱 v${PKG_VERSION} — Cross-chain bridge aggregator MCP server\n`);
        console.log("This is an MCP (Model Context Protocol) server. Add it to your AI tool's config:\n");
        console.log("  Claude Desktop / Claude Code:");
        console.log('    { "mcpServers": { "bridgekitty": { "command": "npx", "args": ["bridgekitty"] } } }\n');
        console.log("  Cursor:");
        console.log("    Add to .cursor/mcp.json with the same format.\n");
        console.log("  Direct (stdio):");
        console.log("    npx bridgekitty --stdio\n");
        console.log("Config: ~/.bridgekitty/.env (override with BRIDGEKITTY_HOME env var)");
        console.log("Docs:   https://github.com/persistenceOne/bridgekitty");
        process.exit(0);
    }
    const engine = createEngine();
    const server = new McpServer({
        name: "bridgekitty",
        version: PKG_VERSION,
    });
    registerGetQuote(server, engine);
    registerExecuteBridge(server, engine);
    registerCheckStatus(server, engine);
    registerGetChains(server, engine);
    registerGetTokens(server, engine);
    registerWalletTools(server);
    registerXprtFarmTools(server, engine);
    registerXprtStakingTools(server);
    registerHelpTool(server);
    registerXprtRewardsCheck(server);
    registerMultiQuote(server, engine);
    registerOnboardTool(server, engine);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("BridgeKitty 🐱 MCP server running on stdio");
}
main().catch((err) => {
    // Sanitize fatal errors to avoid leaking keys/paths in crash output
    const msg = err instanceof Error ? err.message : String(err);
    const safeMsg = msg
        .replace(/\/[\w./-]+\.(ts|js|json|env)/g, "[path]")
        .replace(/0x[a-fA-F0-9]{20,}/g, "[hex-data]")
        .replace(/\b[a-fA-F0-9]{64}\b/g, "[key-redacted]");
    console.error("Fatal error:", safeMsg);
    process.exit(1);
});
