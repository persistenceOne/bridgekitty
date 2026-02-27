#!/usr/bin/env node
// Simple test runner — no MCP handshake, direct execution

const tests = [
  { n: 1,  from: "arbitrum",  fromT: "USDC", to: "ethereum",  toT: "USDC", amt: "100" },
  { n: 2,  from: "base",      fromT: "USDC", to: "arbitrum",  toT: "USDC", amt: "500" },
  { n: 3,  from: "ethereum",  fromT: "ETH",  to: "arbitrum",  toT: "ETH",  amt: "0.1" },
  { n: 4,  from: "optimism",  fromT: "USDC", to: "base",      toT: "USDC", amt: "250" },
  { n: 5,  from: "arbitrum",  fromT: "USDC", to: "ethereum",  toT: "ETH",  amt: "100" },
  { n: 6,  from: "ethereum",  fromT: "ETH",  to: "base",      toT: "USDC", amt: "0.05" },
  { n: 7,  from: "base",      fromT: "ETH",  to: "arbitrum",  toT: "USDC", amt: "0.1" },
  { n: 8,  from: "arbitrum",  fromT: "ETH",  to: "optimism",  toT: "USDC", amt: "0.5" },
  { n: 9,  from: "polygon",   fromT: "USDC", to: "ethereum",  toT: "ETH",  amt: "200" },
  { n: 10, from: "ethereum",  fromT: "USDC", to: "polygon",   toT: "USDC", amt: "1000" },
  { n: 11, from: "avalanche", fromT: "USDC", to: "ethereum",  toT: "USDC", amt: "500" },
  { n: 12, from: "bsc",       fromT: "BNB",  to: "ethereum",  toT: "ETH",  amt: "1" },
  { n: 13, from: "ethereum",  fromT: "WBTC", to: "arbitrum",  toT: "WBTC", amt: "0.01" },
  { n: 14, from: "arbitrum",  fromT: "ETH",  to: "base",      toT: "ETH",  amt: "1" },
  { n: 15, from: "ethereum",  fromT: "USDT", to: "arbitrum",  toT: "USDT", amt: "500" },
  { n: 16, from: "ethereum",  fromT: "USDC", to: "arbitrum",  toT: "ETH",  amt: "1000" },
  { n: 17, from: "base",      fromT: "ETH",  to: "ethereum",  toT: "USDC", amt: "0.5" },
  { n: 18, from: "arbitrum",  fromT: "USDC", to: "base",      toT: "ETH",  amt: "200" },
  { n: 19, from: "ethereum",  fromT: "USDC", to: "arbitrum",  toT: "USDC", amt: "10000" },
  { n: 20, from: "arbitrum",  fromT: "ETH",  to: "ethereum",  toT: "ETH",  amt: "5" },
];

import { spawn } from "child_process";

async function runTest(test) {
  const start = Date.now();
  const req = JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "tools/call",
    params: {
      name: "bridge_get_quote",
      arguments: {
        fromChain: test.from, fromToken: test.fromT,
        toChain: test.to, toToken: test.toT,
        amount: test.amt, fromAddress: "0x0000000000000000000000000000000000000001"
      }
    }
  });

  const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.write(req);
  proc.stdin.end();

  let stdout = "";
  for await (const chunk of proc.stdout) stdout += chunk;
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  try {
    const parsed = JSON.parse(stdout);
    const result = JSON.parse(parsed.result.content[0].text);
    const routes = result.totalRoutesFound || 0;
    const best = result.bestQuote?.provider || "N/A";
    const output = result.bestQuote?.outputAmount || "N/A";
    const status = routes > 0 ? "✅" : "❌";
    return { ...test, elapsed, routes, best, output, status };
  } catch {
    return { ...test, elapsed, routes: 0, best: "N/A", output: "N/A", status: "❌" };
  }
}

async function main() {
  console.log("# BridgeKitty Benchmark — " + new Date().toISOString().slice(0, 16) + "\n");
  console.log("| # | Route | Time (s) | Routes | Best Provider | Output |");
  console.log("|---|-------|----------|--------|---------------|--------|");

  const results = [];
  for (const test of tests) {
    const r = await runTest(test);
    const label = `${r.amt} ${r.fromT} ${r.from} → ${r.toT} ${r.to}`;
    console.log(`| ${r.n} | ${label} | ${r.elapsed} | ${r.routes} | ${r.best} | ${r.output} | ${r.status} |`);
    results.push(r);
  }

  console.log("\n## Summary");
  const times = results.map(r => parseFloat(r.elapsed));
  const successes = results.filter(r => r.routes > 0).length;
  console.log(`- **Success:** ${successes}/20`);
  console.log(`- **Avg time:** ${(times.reduce((a,b) => a+b, 0) / times.length).toFixed(2)}s`);
  console.log(`- **Min time:** ${Math.min(...times).toFixed(2)}s`);
  console.log(`- **Max time:** ${Math.max(...times).toFixed(2)}s`);
  console.log(`- **Total:** ${times.reduce((a,b) => a+b, 0).toFixed(2)}s`);
}
main();
