#!/usr/bin/env node
// BridgeKitty test runner — 20 diverse cases with timing
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDR = "0x0000000000000000000000000000000000000001";

const tests = [
  // Same-token bridging
  { n: 1,  from: "arbitrum",  fromT: "USDC", to: "ethereum",  toT: "USDC", amt: "100" },
  { n: 2,  from: "base",      fromT: "USDC", to: "arbitrum",  toT: "USDC", amt: "500" },
  { n: 3,  from: "ethereum",  fromT: "ETH",  to: "arbitrum",  toT: "ETH",  amt: "0.1" },
  { n: 4,  from: "optimism",  fromT: "USDC", to: "base",      toT: "USDC", amt: "250" },
  // Cross-token swaps
  { n: 5,  from: "arbitrum",  fromT: "USDC", to: "ethereum",  toT: "ETH",  amt: "100" },
  { n: 6,  from: "ethereum",  fromT: "ETH",  to: "base",      toT: "USDC", amt: "0.05" },
  { n: 7,  from: "base",      fromT: "ETH",  to: "arbitrum",  toT: "USDC", amt: "0.1" },
  { n: 8,  from: "arbitrum",  fromT: "ETH",  to: "optimism",  toT: "USDC", amt: "0.5" },
  // Exotic routes
  { n: 9,  from: "polygon",   fromT: "USDC", to: "ethereum",  toT: "ETH",  amt: "200" },
  { n: 10, from: "ethereum",  fromT: "USDC", to: "polygon",   toT: "USDC", amt: "1000" },
  { n: 11, from: "avalanche", fromT: "USDC", to: "ethereum",  toT: "USDC", amt: "500" },
  { n: 12, from: "bsc",       fromT: "BNB",  to: "ethereum",  toT: "ETH",  amt: "1" },
  // DeFi tokens
  { n: 13, from: "ethereum",  fromT: "WBTC", to: "arbitrum",  toT: "WBTC", amt: "0.01" },
  { n: 14, from: "arbitrum",  fromT: "ETH",  to: "base",      toT: "ETH",  amt: "1" },
  { n: 15, from: "ethereum",  fromT: "USDT", to: "arbitrum",  toT: "USDT", amt: "500" },
  // Cross-token DeFi
  { n: 16, from: "ethereum",  fromT: "USDC", to: "arbitrum",  toT: "ETH",  amt: "1000" },
  { n: 17, from: "base",      fromT: "ETH",  to: "ethereum",  toT: "USDC", amt: "0.5" },
  { n: 18, from: "arbitrum",  fromT: "USDC", to: "base",      toT: "ETH",  amt: "200" },
  // Large amounts
  { n: 19, from: "ethereum",  fromT: "USDC", to: "arbitrum",  toT: "USDC", amt: "10000" },
  { n: 20, from: "arbitrum",  fromT: "ETH",  to: "ethereum",  toT: "ETH",  amt: "5" },
];

function sendJsonRpc(child, obj) {
  const msg = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  child.stdin.write(header + msg);
}

function readJsonRpcResponse(child) {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      // Try to find Content-Length header and parse body
      const parts = buf.split("\r\n\r\n");
      if (parts.length >= 2) {
        // Could be multiple messages; find the last complete one
        for (let i = 0; i < parts.length - 1; i++) {
          const headerPart = parts[i];
          const match = headerPart.match(/Content-Length:\s*(\d+)/i);
          if (match) {
            const len = parseInt(match[1]);
            const bodyStart = buf.indexOf(headerPart) + headerPart.length + 4; // +4 for \r\n\r\n
            const body = buf.slice(bodyStart, bodyStart + len);
            if (body.length >= len) {
              try {
                const parsed = JSON.parse(body);
                child.stdout.removeListener("data", onData);
                resolve(parsed);
                return;
              } catch {}
            }
          }
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

async function runTest(child, test) {
  const start = Date.now();
  
  sendJsonRpc(child, {
    jsonrpc: "2.0", id: test.n + 100,
    method: "tools/call",
    params: {
      name: "bridge_get_quote",
      arguments: {
        fromChain: test.from, fromToken: test.fromT,
        toChain: test.to, toToken: test.toT,
        amount: test.amt, fromAddress: ADDR
      }
    }
  });

  const resp = await readJsonRpcResponse(child);
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  
  let routes = 0, bestProvider = "N/A", bestOutput = "N/A", status = "❌";
  try {
    const text = JSON.parse(resp.result.content[0].text);
    routes = text.totalRoutesFound || 0;
    bestProvider = text.bestQuote?.provider || "N/A";
    bestOutput = text.bestQuote?.outputAmount || "N/A";
    status = routes > 0 ? "✅" : "❌";
  } catch (e) {
    // Check if it's an error message (no routes)
    try {
      const errText = resp.result?.content?.[0]?.text || "";
      if (errText.includes("No bridge routes")) status = "⚠️ no routes";
    } catch {}
  }
  
  const label = `${test.amt} ${test.fromT} ${test.from} → ${test.toT} ${test.to}`;
  return { n: test.n, label, elapsed, routes, bestProvider, bestOutput, status };
}

async function main() {
  // Spawn MCP server
  const child = spawn("node", [join(__dirname, "dist/index.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {}); // discard stderr

  // Initialize MCP
  sendJsonRpc(child, {
    jsonrpc: "2.0", id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-runner", version: "1.0.0" }
    }
  });
  await readJsonRpcResponse(child);
  
  // Send initialized notification
  sendJsonRpc(child, { jsonrpc: "2.0", method: "notifications/initialized" });

  console.log("# BridgeKitty Test Results — " + new Date().toISOString().slice(0, 16));
  console.log("");
  console.log("| # | Route | Time (s) | Routes | Best Provider | Output | Status |");
  console.log("|---|-------|----------|--------|---------------|--------|--------|");

  const results = [];
  for (const test of tests) {
    const r = await runTest(child, test);
    const line = `| ${r.n} | ${r.label} | ${r.elapsed} | ${r.routes} | ${r.bestProvider} | ${r.bestOutput} | ${r.status} |`;
    console.log(line);
    results.push(r);
  }

  child.kill();

  console.log("");
  console.log("## Summary");
  const times = results.map(r => parseFloat(r.elapsed));
  const successes = results.filter(r => r.routes > 0).length;
  console.log(`- **Success:** ${successes}/20`);
  console.log(`- **Avg time:** ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}s`);
  console.log(`- **Min time:** ${Math.min(...times).toFixed(2)}s`);
  console.log(`- **Max time:** ${Math.max(...times).toFixed(2)}s`);
  console.log(`- **Total:** ${times.reduce((a, b) => a + b, 0).toFixed(2)}s`);
}

main().catch(console.error);
