import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { PersistenceBackend } from "../backends/persistence.js";
import { getKey, getConfigDir } from "./wallet.js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { simulateTransaction } from "../utils/tx-simulator.js";
import { getProvider } from "../utils/gas-estimator.js";
import { createFillWatcher, checkTransferEvents, checkBalanceChange, getCurrentBlockNumber } from "../utils/fill-detector.js";
import * as path from "path";

const REWARDS_API = "https://rewards.interop.persistence.one";
const PERSISTENCE_REST = "https://rest.core.persistence.one";
const TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 5_000;      // 5s between polls (standard)
const FAST_POLL_INTERVAL_MS = 2_000; // 2s for first 30s (aggressive phase)
const FAST_POLL_DURATION_MS = 30_000; // How long to use fast polling
const STATUS_API_INTERVAL = 3;        // Check status API every Nth poll (secondary, often broken)
const POST_TIMEOUT_COOLDOWN_MS = 30_000; // Extra cooldown after timeouts for RPC propagation

/** Write timestamped progress to stderr (visible in MCP clients as notifications) */
function progress(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  console.error(`[xprt-farm ${ts}] ${msg}`);
}

// Token addresses
const CBTCB_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC on Base (8 decimals)
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"; // BTCB on BSC (18 decimals)

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getBalance(chainId: number, tokenAddress: string, wallet: string): Promise<string> {
  const provider = await getProvider(chainId);
  const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
  const bal: bigint = await contract.balanceOf(wallet);
  return bal.toString();
}

function getMultiplierTier(xprtStaked: number): { tier: string; multiplier: string } {
  if (xprtStaked >= 1_000_000) return { tier: "Pioneer", multiplier: "5x" };
  if (xprtStaked >= 10_000) return { tier: "Voyager", multiplier: "3x" };
  return { tier: "Explorer", multiplier: "1x" };
}

// ─── Dynamic amount clamping ─────────────────────────────────────────────────
// Reads actual token balance, normalizes to 8-dec BTC, clamps to [MIN, MAX].
// Same caps as PersistenceBackend.validateAmount (MIN_AMOUNT_RAW / MAX_AMOUNT_RAW).
const MIN_BTC_8DEC = 5000n;      // 0.00005 BTC (matches persistence.ts MIN_AMOUNT_RAW)
const MAX_BTC_8DEC = 100000n;    // 0.001 BTC (matches persistence.ts MAX_AMOUNT_RAW)

interface ClampedAmount {
  /** Raw amount string in the token's native decimals — ready for quote amountRaw */
  amountRaw: string;
  /** Normalized to 8-decimal BTC for logging / comparison */
  btc8Dec: bigint;
}

// Reduced minimum for return legs (leg 2) — accounts for ~1% solver fee on the outbound leg.
// When leg 1 sends 0.00005 BTC, the solver returns ~0.0000495-0.0000499, which is below
// MIN_BTC_8DEC (5000) but above this threshold (4500 = 0.000045 BTC).
const MIN_BTC_8DEC_LEG2 = 4500n;

async function getClampedAmount(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  decimals: number,
  userCapBtc?: number,
  /** If true, use reduced minimum and ignore cap — for return legs after solver fees */
  isReturnLeg?: boolean
): Promise<ClampedAmount | null> {
  const balanceRaw = BigInt(await getBalance(chainId, tokenAddress, walletAddress));
  // Normalize to 8-decimal BTC (cbBTC is 8-dec, BTCB is 18-dec)
  const balance8Dec = decimals > 8
    ? balanceRaw / (10n ** BigInt(decimals - 8))
    : balanceRaw;

  const effectiveMin = isReturnLeg ? MIN_BTC_8DEC_LEG2 : MIN_BTC_8DEC;
  if (balance8Dec < effectiveMin) return null; // Below minimum

  let clamped = balance8Dec > MAX_BTC_8DEC ? MAX_BTC_8DEC : balance8Dec;
  // For return legs, don't apply user cap — send back whatever we received
  if (!isReturnLeg && userCapBtc !== undefined) {
    const cap8Dec = BigInt(Math.round(userCapBtc * 1e8));
    if (cap8Dec < clamped) clamped = cap8Dec;
  }
  if (clamped < effectiveMin) clamped = effectiveMin;

  // Convert back to native decimals for the quote
  const amountRaw = decimals > 8
    ? (clamped * (10n ** BigInt(decimals - 8))).toString()
    : clamped.toString();

  return { amountRaw, btc8Dec: clamped };
}

// ─── Leg configuration ────────────────────────────────────────────────────────
interface LegConfig {
  chainId: number;
  destChainId: number;
  token: string;
  destToken: string;
  decimals: number;
  label: string;
}

export function registerXprtFarmTools(server: McpServer, engine: RoutingEngine) {
  // ─── xprt_farm_prepare ─────────────────────────────────────────────────────
  server.tool(
    "xprt_farm_prepare",
    "Convert ETH or other tokens to cbBTC and bridge gas to BSC, preparing your wallet for XPRT farming via Persistence Interop.",
    {
      amount: z.string().optional().describe("ETH amount to use (auto-detects balance if omitted)"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        const envPath = path.resolve(getConfigDir(), ".env");
        return {
          content: [{ type: "text" as const, text: `No wallet configured. Add keys to ${envPath} (MNEMONIC=... / PRIVATE_KEY=0x...) or run wallet_setup to generate new keys. Use wallet_status to check.` }],
          isError: true,
        };
      }

      const signer = new ethers.Wallet(privateKey);
      const walletAddress = signer.address;

      // Check ETH balance on Base
      const baseProvider = await getProvider(8453);
      const ethBalance = await baseProvider.getBalance(walletAddress);
      const ethBalanceEth = parseFloat(ethers.formatEther(ethBalance));

      if (ethBalanceEth < 0.003) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Insufficient ETH on Base",
              balance: `${ethBalanceEth.toFixed(6)} ETH`,
              needed: "At least 0.003 ETH (0.002 for gas reserve + 0.001 for swaps)",
              action: `Send ETH to ${walletAddress} on Base (chain ID 8453)`,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const totalEth = params.amount ? parseFloat(params.amount) : ethBalanceEth;
      const gasReserve = 0.002;
      const bnbSwapEth = 0.0002;
      const cbBTCSwapEth = totalEth - gasReserve - bnbSwapEth;

      if (cbBTCSwapEth <= 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Insufficient ETH. After gas reserve (${gasReserve}) and BNB swap (${bnbSwapEth}), nothing left for cbBTC. Balance: ${ethBalanceEth.toFixed(6)} ETH`,
          }],
          isError: true,
        };
      }

      const steps: Array<{ step: string; status: string; details?: any }> = [];

      // Step 1: Swap ETH → BNB on BSC via cross-chain bridge
      try {
        const bnbAmountRaw = ethers.parseEther(bnbSwapEth.toFixed(6)).toString();
        const bnbQuoteParams = {
          fromChainId: 8453,
          toChainId: 56,
          fromTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          toTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          amountRaw: bnbAmountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
        };

        const backends = engine.getAllBackends().filter(b => b.name !== "persistence");
        let bestQuote = null;
        for (const backend of backends) {
          try {
            const q = await backend.getQuote(bnbQuoteParams);
            if (q && (!bestQuote || parseFloat(q.outputAmount) > parseFloat(bestQuote.outputAmount))) {
              bestQuote = q;
            }
          } catch { /* skip */ }
        }

        if (bestQuote) {
          const backend = engine.getBackend(bestQuote.backendName);
          if (backend) {
            const tx = await backend.buildTransaction(bestQuote);
            // Simulate before sending
            const sim = await simulateTransaction(tx.chainId, { to: tx.to, data: tx.data, value: tx.value, from: walletAddress });
            if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);
            const connectedSigner = signer.connect(await getProvider(tx.chainId));
            const txResponse = await connectedSigner.sendTransaction({
              to: tx.to,
              data: tx.data,
              value: tx.value,
              ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
            });
            await txResponse.wait();
            steps.push({ step: "ETH→BNB (BSC gas)", status: "success", details: { txHash: txResponse.hash, amount: `${bnbSwapEth} ETH` } });
          }
        } else {
          steps.push({ step: "ETH→BNB (BSC gas)", status: "skipped", details: "No route found" });
        }
      } catch (err) {
        steps.push({ step: "ETH→BNB (BSC gas)", status: `failed: ${sanitizeError(err as Error)}` });
      }

      // Step 2: Swap ETH → cbBTC on Base (same-chain)
      try {
        const cbBTCAmountRaw = ethers.parseEther(cbBTCSwapEth.toFixed(6)).toString();
        const cbBTCQuoteParams = {
          fromChainId: 8453,
          toChainId: 8453,
          fromTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          toTokenAddress: CBTCB_BASE,
          amountRaw: cbBTCAmountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
        };

        const backends = engine.getAllBackends().filter(b => b.name !== "persistence");
        let bestQuote = null;
        for (const backend of backends) {
          try {
            const q = await backend.getQuote(cbBTCQuoteParams);
            if (q && (!bestQuote || parseFloat(q.outputAmount) > parseFloat(bestQuote.outputAmount))) {
              bestQuote = q;
            }
          } catch { /* skip */ }
        }

        if (bestQuote) {
          const backend = engine.getBackend(bestQuote.backendName);
          if (backend) {
            let tx = await backend.buildTransaction(bestQuote);
            const connectedSigner = signer.connect(baseProvider);

            if (tx.approvalTx) {
              const approvalResponse = await connectedSigner.sendTransaction({
                to: tx.approvalTx.to,
                data: tx.approvalTx.data,
                value: tx.approvalTx.value,
              });
              await approvalResponse.wait();
            }

            // Simulate before sending
            const sim2 = await simulateTransaction(tx.chainId, { to: tx.to, data: tx.data, value: tx.value, from: walletAddress });
            if (!sim2.success) throw new Error(`Simulation failed: ${sim2.error}`);
            const txResponse = await connectedSigner.sendTransaction({
              to: tx.to,
              data: tx.data,
              value: tx.value,
              ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
            });
            await txResponse.wait();
            steps.push({ step: "ETH→cbBTC (Base)", status: "success", details: { txHash: txResponse.hash, amount: `${cbBTCSwapEth.toFixed(6)} ETH` } });
          }
        } else {
          steps.push({ step: "ETH→cbBTC (Base)", status: "skipped", details: "No route found" });
        }
      } catch (err) {
        steps.push({ step: "ETH→cbBTC (Base)", status: `failed: ${sanitizeError(err as Error)}` });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "completed",
            wallet: walletAddress,
            gasReserve: `${gasReserve} ETH kept on Base`,
            steps,
            nextStep: "Run xprt_farm_start to begin XPRT farming",
          }, null, 2),
        }],
      };
    }
  );

  // ─── xprt_farm_start ────────────────────────────────────────────────────────
  server.tool(
    "xprt_farm_start",
    "Start XPRT farming by running automated BTC round-trip swaps between BSC and Base via Persistence Interop. " +
    "Earn XPRT rewards distributed daily as airdrops — not guaranteed income. " +
    "Preconditions: Requires wallet_setup to have been run. Requires cbBTC on Base and/or BTCB on BSC (min 0.00005 BTC). Requires gas on both Base and BSC. " +
    "Call wallet_balance before starting to verify sufficient balances. " +
    "Response includes per-leg detail: amountSent, amountReceived, feeBps, provider, status, and durationSeconds.",
    {
      amount: z.string().optional().describe(
        "Max BTC to send on the outbound leg of each round (e.g. '0.0003'). " +
        "The return leg will bridge the full received balance back; actual return amount depends on bridge fees. " +
        "Omit to use full available balance, clamped to protocol limits 0.00005–0.001 BTC."
      ),
      startFrom: z.enum(["base", "bsc", "auto"]).default("auto").describe("'auto' (detect best direction), 'base' (cbBTC→BTCB), or 'bsc' (BTCB→cbBTC)"),
      rounds: z.number().default(10).describe("Number of round trips (default 10)"),
      delay: z.number().default(30).describe("Delay between rounds in seconds (default 30)"),
      fillTimeout: z.number().default(180).describe("Max seconds to wait for each leg fill (default 180, minimum 90)"),
      maxFailures: z.number().default(3).describe("Stop after N consecutive failures (default 3)"),
      maxLossBps: z.number().default(200).describe("Stop if cumulative loss exceeds N basis points (default 200 = 2%)"),
      dryRun: z.boolean().optional().describe("Preview the farming operation without executing transactions (default: false)"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        return {
          content: [{ type: "text" as const, text: `No wallet configured. Add keys to ${path.resolve(getConfigDir(), ".env")} (MNEMONIC=... / PRIVATE_KEY=0x...) or run wallet_setup to generate new keys. Use wallet_status to check.` }],
          isError: true,
        };
      }

      const signer = new ethers.Wallet(privateKey);
      const walletAddress = signer.address;
      const persistence = new PersistenceBackend();

      // Parse optional user cap (in BTC)
      const userCapBtc = params.amount ? parseFloat(params.amount) : undefined;
      const effectiveTimeout = Math.max(params.fillTimeout, 90); // minimum 90s
      const maxPolls = Math.ceil((effectiveTimeout * 1000) / POLL_INTERVAL_MS);

      // Auto-detect best startFrom direction
      let resolvedStartFrom: "base" | "bsc" = params.startFrom === "auto" ? "base" : params.startFrom;
      if (params.startFrom === "auto") {
        progress("Auto-detecting best direction...");
        let baseBal: ClampedAmount | null = null;
        let bscBal: ClampedAmount | null = null;
        try { baseBal = await getClampedAmount(8453, CBTCB_BASE, walletAddress, 8, userCapBtc); } catch { /* non-fatal */ }
        try { bscBal = await getClampedAmount(56, BTCB_BSC, walletAddress, 18, userCapBtc); } catch { /* non-fatal */ }

        if (!baseBal && !bscBal) {
          // Neither chain has enough — return detailed error with both balances
          let baseRaw = "0", bscRaw = "0";
          try { baseRaw = await getBalance(8453, CBTCB_BASE, walletAddress); } catch {}
          try { bscRaw = await getBalance(56, BTCB_BSC, walletAddress); } catch {}
          const baseHuman = (Number(baseRaw) / 1e8).toFixed(8);
          const bscHuman = ethers.formatUnits(bscRaw, 18);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Insufficient BTC balance on both chains",
                minimum: "0.00005 BTC per leg",
                balances: {
                  "Base cbBTC": `${baseHuman} BTC`,
                  "BSC BTCB": `${bscHuman} BTC`,
                },
                action: "Run xprt_farm_prepare to convert ETH to cbBTC, or send BTC to your wallet.",
              }, null, 2),
            }],
            isError: true,
          };
        }

        if (baseBal && !bscBal) {
          resolvedStartFrom = "base";
        } else if (bscBal && !baseBal) {
          resolvedStartFrom = "bsc";
        } else {
          // Both have balance — pick the one with more BTC
          resolvedStartFrom = baseBal!.btc8Dec >= bscBal!.btc8Dec ? "base" : "bsc";
        }
        progress(`Auto-detected: starting from ${resolvedStartFrom} (${resolvedStartFrom === "base" ? "cbBTC" : "BTCB"})`);
      }

      // Compute leg configs based on resolved direction
      const leg1: LegConfig = resolvedStartFrom === "bsc"
        ? { chainId: 56, destChainId: 8453, token: BTCB_BSC, destToken: CBTCB_BASE, decimals: 18, label: "BSC→Base" }
        : { chainId: 8453, destChainId: 56, token: CBTCB_BASE, destToken: BTCB_BSC, decimals: 8, label: "Base→BSC" };
      const leg2: LegConfig = resolvedStartFrom === "bsc"
        ? { chainId: 8453, destChainId: 56, token: CBTCB_BASE, destToken: BTCB_BSC, decimals: 8, label: "Base→BSC" }
        : { chainId: 56, destChainId: 8453, token: BTCB_BSC, destToken: CBTCB_BASE, decimals: 18, label: "BSC→Base" };

      interface LegResult {
        txHash: string;
        orderId: string;
        status: string;
        amountSent: string;      // BTC sent on this leg
        amountReceived?: string; // BTC received on destination (after fees)
        feeBps?: number;         // Bridge fee in basis points
        provider: string;        // Bridge provider (e.g. 'persistence')
        txHashSource?: string;   // Source chain tx hash
        txHashDest?: string;     // Destination chain tx hash (once confirmed)
        durationSeconds?: number; // Time from submission to destination confirmation
      }
      const results: Array<{
        round: number;
        leg1?: LegResult;
        leg2?: LegResult;
      }> = [];

      let consecutiveFailures = 0;
      let completedRounds = 0;
      let totalLossBps = 0;

      // Track loss using "home" chain balance (the chain we start from)
      let initialHomeBalance8Dec: bigint | null = null;
      try {
        const homeBal = BigInt(await getBalance(leg1.chainId, leg1.token, walletAddress));
        initialHomeBalance8Dec = leg1.decimals > 8
          ? homeBal / (10n ** BigInt(leg1.decimals - 8))
          : homeBal;
      } catch { /* non-fatal */ }

      const directionLabel = resolvedStartFrom === "bsc" ? "BSC→Base→BSC" : "Base→BSC→Base";

      // ── Dry Run Preview ──────────────────────────────────────────────
      if (params.dryRun) {
        progress("DRY RUN: Generating preview without executing...");
        
        // Get current balances
        let leg1BalanceRaw = "0";
        let leg2BalanceRaw = "0";
        try {
          leg1BalanceRaw = await getBalance(leg1.chainId, leg1.token, walletAddress);
          leg2BalanceRaw = await getBalance(leg2.destChainId, leg2.destToken, walletAddress);
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `DRY RUN FAILED: Could not fetch balances - ${(err as Error).message}`,
            }],
            isError: true,
          };
        }

        const leg1Balance = ethers.formatUnits(leg1BalanceRaw, leg1.decimals);
        const leg2Balance = ethers.formatUnits(leg2BalanceRaw, leg2.decimals);

        // Get a quote for leg 1 to estimate output
        let estimatedOutput = "unknown";
        let estimatedLoss = "unknown";
        try {
          const clamped = await getClampedAmount(leg1.chainId, leg1.token, walletAddress, leg1.decimals, userCapBtc);
          if (clamped) {
            const quoteParams = {
              fromChainId: leg1.chainId,
              toChainId: leg1.destChainId,
              fromTokenAddress: leg1.token,
              toTokenAddress: leg1.destToken,
              amountRaw: clamped.amountRaw,
              fromAddress: walletAddress,
              preference: "fastest" as const,
            };
            const quote = await persistence.getQuote(quoteParams);
            if (quote) {
              const outputBtc = Number(quote.minOutputAmountRaw) / (leg1.destToken === CBTCB_BASE ? 1e8 : 1e18);
              const inputBtc = Number(clamped.amountRaw) / (leg1.token === CBTCB_BASE ? 1e8 : 1e18);
              const lossBps = Math.round(((inputBtc - outputBtc) / inputBtc) * 10000);
              estimatedOutput = outputBtc.toFixed(8);
              estimatedLoss = `~${lossBps} bps (${(lossBps / 100).toFixed(2)}%)`;
            }
          }
        } catch {
          // Quote failed, keep unknown
        }

        const preview = {
          dryRun: true,
          preview: {
            direction: directionLabel,
            inputAmount: `${leg1Balance} ${leg1.label.includes("Base") ? "cbBTC" : "BTCB"}`,
            estimatedOutput: estimatedOutput === "unknown" ? "unknown" : `${estimatedOutput} ${leg1.label.includes("BSC") ? "BTCB" : "cbBTC"}`,
            estimatedSingleLegLoss: estimatedLoss,
            estimatedRoundTripLoss: estimatedLoss === "unknown" ? "unknown" : `~${parseInt(estimatedLoss) * 2} bps`,
            estimatedGas: "<$0.01 per leg on L2",
            rounds: params.rounds,
            totalEstimatedTime: `~${Math.ceil(params.rounds * (effectiveTimeout * 2 + params.delay) / 60)} minutes`,
            balances: {
              [leg1.label.split("→")[0]]: `${leg1Balance} ${leg1.label.includes("Base") ? "cbBTC" : "BTCB"}`,
              [leg2.label.split("→")[0]]: `${leg2Balance} ${leg2.label.includes("Base") ? "cbBTC" : "BTCB"}`,
            },
            note: "Set dryRun=false to execute the farming operation.",
          },
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(preview, null, 2),
          }],
        };
      }

      progress(`Starting ${params.rounds} rounds, direction: ${directionLabel}, fillTimeout: ${effectiveTimeout}s`);

      for (let i = 0; i < params.rounds; i++) {
        if (consecutiveFailures >= params.maxFailures) {
          progress(`STOPPED: ${consecutiveFailures} consecutive failures (max: ${params.maxFailures})`);
          break;
        }
        if (totalLossBps >= params.maxLossBps) {
          progress(`STOPPED: cumulative loss ${totalLossBps} bps exceeds max ${params.maxLossBps}`);
          break;
        }

        progress(`── Round ${i + 1}/${params.rounds} ──`);
        const roundResult: (typeof results)[number] = { round: i + 1 };
        let roundFailed = false;
        let hadTimeout = false;

        // ── Leg 1 ──────────────────────────────────────────────────────
        try {
          // Capture pre-leg destination balance for post-timeout verification
          let preDestBalance1 = 0n;
          try {
            preDestBalance1 = BigInt(await getBalance(leg1.destChainId, leg1.destToken, walletAddress));
          } catch { /* non-fatal */ }

          const clamped1 = await getClampedAmount(
            leg1.chainId, leg1.token, walletAddress, leg1.decimals, userCapBtc
          );
          if (!clamped1) throw new Error(`Balance below minimum 0.00005 BTC on ${leg1.label.split("→")[0]}`);

          progress(`Leg 1 (${leg1.label}): ${Number(clamped1.btc8Dec) / 1e8} BTC`);

          const quote1 = await persistence.getQuote({
            fromChainId: leg1.chainId, toChainId: leg1.destChainId,
            fromTokenAddress: leg1.token, toTokenAddress: leg1.destToken,
            amountRaw: clamped1.amountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote1) throw new Error(`No quote available for ${leg1.label}`);

          // Create push-based fill watcher BEFORE signing — gives the WS
          // connections 5-15s to establish + subscribe while tx is being signed.
          // Uses eth_subscribe("logs") which pushes events in real-time (3-15s),
          // unlike eth_getLogs which is cached server-side for 30-120s.
          const watcher1 = createFillWatcher(
            leg1.destChainId, leg1.destToken, walletAddress,
            () => progress(`Leg 1: fill PUSHED via eth_subscribe`),
          );

          // Capture destination chain block number for HTTP getLogs fallback.
          let startBlock1: number;
          try { startBlock1 = Math.max(0, await getCurrentBlockNumber(leg1.destChainId) - 2); }
          catch { startBlock1 = 0; }

          // signAndExecute waits for source tx confirmation — tokens leave wallet here.
          // While this runs (5-15s), the WS subscription is establishing.
          const leg1Start = Date.now();
          const result1 = await persistence.signAndExecute(quote1, signer);
          roundResult.leg1 = {
            txHash: result1.txHash, orderId: result1.orderId, status: "submitted",
            amountSent: `${Number(clamped1.btc8Dec) / 1e8}`,
            provider: "persistence",
            txHashSource: result1.txHash,
          };
          progress(`Leg 1 tx confirmed: ${result1.txHash.slice(0, 18)}... — polling for destination fill (${watcher1.connectedCount()} WS connections)...`);

          // Multi-signal fill detection (4 prongs, fastest-first):
          // 0. eth_subscribe push (primary — real-time, no caching), 3-15s
          // 1. HTTP getLogs — rotated RPCs, 30-120s (server-side cached)
          // 2. HTTP balance check — rotated RPCs, 30-120s (server-side cached)
          // 3. Status API every Nth poll (often broken)
          let fulfilled = false;
          let legFailed = false;
          for (let w = 0; w < maxPolls; w++) {
            const pollMs = (w * POLL_INTERVAL_MS < FAST_POLL_DURATION_MS) ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
            await new Promise(r => setTimeout(r, pollMs));

            // Prong 0: eth_subscribe push detection (primary — real-time)
            if (watcher1.isDetected()) {
              fulfilled = true;
              progress(`Leg 1: fill confirmed via WS subscription [${(w + 1) * 5}s]`);
              break;
            }

            // Prong 1: HTTP getLogs with RPC rotation (fallback)
            try {
              const eventResult = await checkTransferEvents(
                leg1.destChainId, leg1.destToken, walletAddress, startBlock1, w
              );
              if (eventResult.found) {
                fulfilled = true;
                progress(`Leg 1: fill confirmed via Transfer event [${(w + 1) * 5}s]`);
                break;
              }
              if (eventResult.latestBlock && eventResult.latestBlock > startBlock1) {
                startBlock1 = eventResult.latestBlock - 1;
              }
            } catch { /* non-fatal */ }

            // Prong 2: Balance check with RPC rotation (fallback)
            try {
              const balResult = await checkBalanceChange(
                leg1.destChainId, leg1.destToken, walletAddress, preDestBalance1, w
              );
              if (balResult.changed) {
                fulfilled = true;
                const delta = balResult.newBalance - preDestBalance1;
                progress(`Leg 1: fill confirmed via balance (+${((Number(delta) / 1e8) * (leg1.destChainId === 56 ? 1e-10 : 1)).toFixed(8)} BTC) [${(w + 1) * 5}s]`);
                break;
              }
            } catch { /* non-fatal */ }

            // Prong 3: Status API every Nth poll (often broken)
            if ((w + 1) % STATUS_API_INTERVAL === 0) {
              const status = await persistence.getStatus(result1.trackingId, { orderId: result1.orderId });
              if (status.state === "completed") { fulfilled = true; progress(`Leg 1: fill confirmed via status API`); break; }
              if (status.state === "failed") { legFailed = true; break; }
              progress(`Leg 1 polling... ${(w + 1) * 5}s/${effectiveTimeout}s (status: ${status.humanReadable ?? status.state})`);
            }
          }
          watcher1.cleanup();

          if (fulfilled) {
            progress(`Leg 1 COMPLETED`);
            roundResult.leg1.status = "completed";
            roundResult.leg1.durationSeconds = Math.round((Date.now() - leg1Start) / 1000);
            // Calculate amount received on destination
            try {
              const postDestBalance1 = BigInt(await getBalance(leg1.destChainId, leg1.destToken, walletAddress));
              const received = postDestBalance1 - preDestBalance1;
              const receivedDecimals = leg1.destChainId === 56 ? 18 : 8;
              const received8Dec = receivedDecimals > 8 ? received / (10n ** BigInt(receivedDecimals - 8)) : received;
              roundResult.leg1.amountReceived = `${Number(received8Dec) / 1e8}`;
              // Calculate fee in basis points
              if (clamped1.btc8Dec > 0n && received8Dec > 0n) {
                const feeBps = Number(((clamped1.btc8Dec - received8Dec) * 10000n) / clamped1.btc8Dec);
                roundResult.leg1.feeBps = feeBps;
              }
            } catch { /* non-fatal — balance check for amountReceived */ }
          } else if (legFailed) {
            progress(`Leg 1 FAILED — order rejected by solver`);
            roundResult.leg1.status = "failed: order rejected";
            roundFailed = true;
          } else {
            // Final fallback: one more balance check with 20s delay using fresh provider
            progress(`Leg 1 polling exhausted — final balance check with 20s delay...`);
            let destVerified = false;
            await new Promise(r => setTimeout(r, 20_000));
            try {
              const fallback = await checkBalanceChange(
                leg1.destChainId, leg1.destToken, walletAddress, preDestBalance1, maxPolls + 1
              );
              if (fallback.changed) {
                destVerified = true;
                progress(`Leg 1: destination balance increased after final retry`);
              }
            } catch { /* non-fatal */ }

            if (destVerified) {
              roundResult.leg1.status = "completed_late";
              hadTimeout = true;
            } else {
              progress(`Leg 1 TIMEOUT — destination balance still unchanged`);
              roundResult.leg1.status = "timeout";
              roundFailed = true;
              hadTimeout = true;
            }
          }
        } catch (err) {
          progress(`Leg 1 ERROR: ${sanitizeError(err as Error)}`);
          roundResult.leg1 = { txHash: "", orderId: "", status: `failed: ${sanitizeError(err as Error)}`, amountSent: "0", provider: "persistence" };
          roundFailed = true;
        }

        if (roundFailed) {
          progress(`Round ${i + 1} failed at leg 1: ${roundResult.leg1?.status}`);
          results.push(roundResult);
          consecutiveFailures++;
          // Extra cooldown after timeouts to let pending txs settle
          if (hadTimeout) {
            progress(`Post-timeout cooldown: waiting 30s for pending tx to settle...`);
            await new Promise(r => setTimeout(r, POST_TIMEOUT_COOLDOWN_MS));
          }
          continue;
        }

        // Brief pause between legs
        await new Promise(r => setTimeout(r, 5_000));
        // Extra cooldown if leg1 was a late completion
        if (hadTimeout) {
          progress(`Post-timeout cooldown: waiting 30s for balance propagation...`);
          await new Promise(r => setTimeout(r, POST_TIMEOUT_COOLDOWN_MS));
        }

        // ── Leg 2 ──────────────────────────────────────────────────────
        try {
          // Capture pre-leg destination balance for post-timeout verification
          let preDestBalance2 = 0n;
          try {
            preDestBalance2 = BigInt(await getBalance(leg2.destChainId, leg2.destToken, walletAddress));
          } catch { /* non-fatal */ }

          const clamped2 = await getClampedAmount(
            leg2.chainId, leg2.token, walletAddress, leg2.decimals, userCapBtc, true /* isReturnLeg */
          );
          if (!clamped2) throw new Error(`Balance below minimum 0.000045 BTC on ${leg2.label.split("→")[0]} (solver fees may have reduced the amount too much)`);

          progress(`Leg 2 (${leg2.label}): ${Number(clamped2.btc8Dec) / 1e8} BTC`);

          const quote2 = await persistence.getQuote({
            fromChainId: leg2.chainId, toChainId: leg2.destChainId,
            fromTokenAddress: leg2.token, toTokenAddress: leg2.destToken,
            amountRaw: clamped2.amountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote2) throw new Error(`No quote available for ${leg2.label}`);

          // Create push-based fill watcher BEFORE signing (same strategy as leg 1)
          const watcher2 = createFillWatcher(
            leg2.destChainId, leg2.destToken, walletAddress,
            () => progress(`Leg 2: fill PUSHED via eth_subscribe`),
          );

          // Capture destination chain block number for HTTP getLogs fallback
          let startBlock2: number;
          try { startBlock2 = Math.max(0, await getCurrentBlockNumber(leg2.destChainId) - 2); }
          catch { startBlock2 = 0; }

          const leg2Start = Date.now();
          const result2 = await persistence.signAndExecute(quote2, signer);
          roundResult.leg2 = {
            txHash: result2.txHash, orderId: result2.orderId, status: "submitted",
            amountSent: `${Number(clamped2.btc8Dec) / 1e8}`,
            provider: "persistence",
            txHashSource: result2.txHash,
          };
          progress(`Leg 2 tx confirmed: ${result2.txHash.slice(0, 18)}... — polling for destination fill (${watcher2.connectedCount()} WS connections)...`);

          // Multi-signal fill detection (same 4-prong strategy as leg 1)
          let fulfilled = false;
          let legFailed = false;
          for (let w = 0; w < maxPolls; w++) {
            const pollMs = (w * POLL_INTERVAL_MS < FAST_POLL_DURATION_MS) ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
            await new Promise(r => setTimeout(r, pollMs));

            // Prong 0: eth_subscribe push detection (primary — real-time)
            if (watcher2.isDetected()) {
              fulfilled = true;
              progress(`Leg 2: fill confirmed via WS subscription [${(w + 1) * 5}s]`);
              break;
            }

            // Prong 1: HTTP getLogs with RPC rotation (fallback)
            try {
              const eventResult = await checkTransferEvents(
                leg2.destChainId, leg2.destToken, walletAddress, startBlock2, w
              );
              if (eventResult.found) {
                fulfilled = true;
                progress(`Leg 2: fill confirmed via Transfer event [${(w + 1) * 5}s]`);
                break;
              }
              if (eventResult.latestBlock && eventResult.latestBlock > startBlock2) {
                startBlock2 = eventResult.latestBlock - 1;
              }
            } catch { /* non-fatal */ }

            // Prong 2: Balance check with RPC rotation (fallback)
            try {
              const balResult = await checkBalanceChange(
                leg2.destChainId, leg2.destToken, walletAddress, preDestBalance2, w
              );
              if (balResult.changed) {
                fulfilled = true;
                const delta = balResult.newBalance - preDestBalance2;
                progress(`Leg 2: fill confirmed via balance (+${((Number(delta) / 1e8) * (leg2.destChainId === 56 ? 1e-10 : 1)).toFixed(8)} BTC) [${(w + 1) * 5}s]`);
                break;
              }
            } catch { /* non-fatal */ }

            // Prong 3: Status API every Nth poll (often broken)
            if ((w + 1) % STATUS_API_INTERVAL === 0) {
              const status = await persistence.getStatus(result2.trackingId, { orderId: result2.orderId });
              if (status.state === "completed") { fulfilled = true; progress(`Leg 2: fill confirmed via status API`); break; }
              if (status.state === "failed") { legFailed = true; break; }
              progress(`Leg 2 polling... ${(w + 1) * 5}s/${effectiveTimeout}s (status: ${status.humanReadable ?? status.state})`);
            }
          }
          watcher2.cleanup();

          // Helper: track loss and count completion
          const countRoundCompleted = async () => {
            completedRounds++;
            consecutiveFailures = 0;
            try {
              if (initialHomeBalance8Dec !== null && initialHomeBalance8Dec > 0n) {
                const bal = await getBalance(leg1.chainId, leg1.token, walletAddress);
                const current8Dec = leg1.decimals > 8
                  ? BigInt(bal) / (10n ** BigInt(leg1.decimals - 8))
                  : BigInt(bal);
                if (current8Dec < initialHomeBalance8Dec) {
                  totalLossBps = Number(
                    ((initialHomeBalance8Dec - current8Dec) * 10000n) / initialHomeBalance8Dec
                  );
                  progress(`Cumulative loss: ${totalLossBps} bps`);
                }
              }
            } catch { /* balance check failed — non-fatal, skip loss tracking */ }
          };

          if (fulfilled) {
            progress(`Leg 2 COMPLETED`);
            roundResult.leg2.status = "completed";
            roundResult.leg2.durationSeconds = Math.round((Date.now() - leg2Start) / 1000);
            // Calculate amount received on destination
            try {
              const postDestBalance2 = BigInt(await getBalance(leg2.destChainId, leg2.destToken, walletAddress));
              const received2 = postDestBalance2 - preDestBalance2;
              const receivedDecimals2 = leg2.destChainId === 56 ? 18 : 8;
              const received8Dec2 = receivedDecimals2 > 8 ? received2 / (10n ** BigInt(receivedDecimals2 - 8)) : received2;
              roundResult.leg2.amountReceived = `${Number(received8Dec2) / 1e8}`;
              if (clamped2.btc8Dec > 0n && received8Dec2 > 0n) {
                const feeBps2 = Number(((clamped2.btc8Dec - received8Dec2) * 10000n) / clamped2.btc8Dec);
                roundResult.leg2.feeBps = feeBps2;
              }
            } catch { /* non-fatal */ }
            await countRoundCompleted();
          } else if (legFailed) {
            progress(`Leg 2 FAILED — order rejected by solver`);
            roundResult.leg2.status = "failed: order rejected";
            consecutiveFailures++;
          } else {
            // Final fallback: one more balance check with 20s delay using fresh provider
            progress(`Leg 2 polling exhausted — final balance check with 20s delay...`);
            let destVerified = false;
            await new Promise(r => setTimeout(r, 20_000));
            try {
              const fallback = await checkBalanceChange(
                leg2.destChainId, leg2.destToken, walletAddress, preDestBalance2, maxPolls + 1
              );
              if (fallback.changed) {
                destVerified = true;
                progress(`Leg 2: destination balance increased after final retry`);
              }
            } catch { /* non-fatal */ }

            if (destVerified) {
              roundResult.leg2.status = "completed_late";
              await countRoundCompleted();
              hadTimeout = true;
            } else {
              progress(`Leg 2 TIMEOUT — destination balance still unchanged`);
              roundResult.leg2.status = "timeout";
              consecutiveFailures++;
              hadTimeout = true;
            }
          }
        } catch (err) {
          progress(`Leg 2 ERROR: ${sanitizeError(err as Error)}`);
          roundResult.leg2 = { txHash: "", orderId: "", status: `failed: ${sanitizeError(err as Error)}`, amountSent: "0", provider: "persistence" };
          consecutiveFailures++;
        }

        progress(`Round ${i + 1} result: leg1=${roundResult.leg1?.status ?? "n/a"}, leg2=${roundResult.leg2?.status ?? "n/a"}`);
        results.push(roundResult);

        if (i < params.rounds - 1 && consecutiveFailures < params.maxFailures) {
          // Extra cooldown after timeouts
          if (hadTimeout) {
            progress(`Post-timeout cooldown: waiting 30s...`);
            await new Promise(r => setTimeout(r, POST_TIMEOUT_COOLDOWN_MS));
          }
          await new Promise(r => setTimeout(r, params.delay * 1000));
        }
      }

      progress(`Finished. Completed: ${completedRounds}/${results.length} rounds, loss: ${totalLossBps} bps`);

      // Calculate total volume for reward estimation
      let totalVolumeBtc = 0;
      for (const r of results) {
        if (r.leg1?.amountSent) totalVolumeBtc += parseFloat(r.leg1.amountSent);
        if (r.leg2?.amountSent) totalVolumeBtc += parseFloat(r.leg2.amountSent);
      }

      // Fetch current multiplier for reward summary
      let currentMultiplier = "1x";
      let nextMultiplierThreshold: string | undefined;
      try {
        const linkData = await fetchJson(`${REWARDS_API}/address-verification/check/${walletAddress}`);
        if (linkData.isRegistered && linkData.persistenceAddress) {
          // Check multiplier from rewards API first (canonical), then fall back to delegation query
          const today = new Date().toISOString().slice(0, 10);
          let resolved = false;
          try {
            const tierData = await fetchJson(`${REWARDS_API}/tiers/${linkData.persistenceAddress}?blockDate=${today}`);
            if (tierData.multiplier) {
              currentMultiplier = `${tierData.multiplier}x`;
              resolved = true;
            }
          } catch { /* fall through to delegation-based lookup */ }

          if (!resolved) {
            // Fallback: check staked (delegated) balance — not liquid balance!
            const delData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/delegations/${linkData.persistenceAddress}`);
            const totalDelegated = (delData.delegation_responses ?? []).reduce((sum: number, d: any) => {
              return sum + parseInt(d.balance?.amount ?? "0") / 1e6;
            }, 0);
            const tier = getMultiplierTier(totalDelegated);
            currentMultiplier = tier.multiplier;
            if (tier.tier === "Explorer") nextMultiplierThreshold = "Stake 10,000 XPRT to reach 2x multiplier";
            else if (tier.tier === "Voyager") nextMultiplierThreshold = "Stake 1,000,000 XPRT to reach 5x multiplier";
          }
        }
      } catch { /* non-fatal */ }

      const rewardSummary = {
        totalVolumeBtc: totalVolumeBtc.toFixed(8),
        estimatedXprtPerRound: "Varies by epoch participation — check xprt_rewards_check for current estimates",
        currentMultiplier,
        nextMultiplierThreshold,
        suggestion: completedRounds > 0
          ? "Run xprt_rewards_check to see your accumulated rewards. Consider staking XPRT for a higher multiplier."
          : "No rounds completed. Check balances and gas, then try again.",
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "completed",
            wallet: walletAddress,
            direction: directionLabel,
            amountMode: userCapBtc ? `capped at ${userCapBtc} BTC` : "max available (clamped to 0.00005–0.001 BTC)",
            completedRounds,
            totalAttempted: results.length,
            totalLossBps,
            stoppedEarly: consecutiveFailures >= params.maxFailures ? "max consecutive failures" :
              totalLossBps >= params.maxLossBps ? "max loss threshold" : null,
            rounds: results,
            rewardSummary,
            disclaimer: "Rewards are estimated and not guaranteed. Actual XPRT distribution depends on total epoch participation.",
          }, null, 2),
        }],
      };
    }
  );

  // ─── xprt_farm_status ───────────────────────────────────────────────────────
  server.tool(
    "xprt_farm_status",
    "Check your XPRT farming status: wallet link, BTC balances, current epoch reward pool. Rewards are estimated and change based on total participation.",
    {},
    async () => {
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        return {
          content: [{ type: "text" as const, text: `No wallet configured. Add keys to ${path.resolve(getConfigDir(), ".env")} (MNEMONIC=... / PRIVATE_KEY=0x...) or run wallet_setup to generate new keys. Use wallet_status to check.` }],
          isError: true,
        };
      }

      const wallet = new ethers.Wallet(privateKey);
      const evmAddress = wallet.address;
      const result: Record<string, any> = { wallet: evmAddress };

      try {
        const linkData = await fetchJson(`${REWARDS_API}/address-verification/check/${evmAddress}`);
        result.linked = linkData.isRegistered ?? false;
        if (linkData.persistenceAddress) result.persistenceAddress = linkData.persistenceAddress;
      } catch {
        result.linked = "unknown (check failed)";
      }

      try {
        const [cbBTCBal, btcbBal] = await Promise.all([
          getBalance(8453, CBTCB_BASE, evmAddress),
          getBalance(56, BTCB_BSC, evmAddress),
        ]);
        result.balances = {
          "Base (cbBTC)": ethers.formatUnits(cbBTCBal, 8),
          "BSC (BTCB)": ethers.formatUnits(btcbBal, 18),
        };
      } catch (err) {
        result.balances = `Error: ${sanitizeError(err as Error)}`;
      }

      try {
        const epoch = await fetchJson(`${REWARDS_API}/epochs/current`);
        result.currentEpoch = {
          epochNumber: epoch.epochNumber,
          startDate: epoch.startDate,
          endDate: epoch.endDate,
          status: epoch.status,
          rewardPoolXprt: epoch.rewardPoolXprt ? `~${Number(epoch.rewardPoolXprt).toFixed(2)} XPRT` : undefined,
        };
      } catch {
        result.currentEpoch = "Could not fetch";
      }

      result.disclaimer = "Estimated rewards are not guaranteed and change based on total participation.";

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── xprt_farm_boost ────────────────────────────────────────────────────────
  server.tool(
    "xprt_farm_boost",
    "Buy XPRT with any token and auto-stake for XPRT farming multiplier boost. " +
    "One command to go from 1x to 2x or 5x multiplier. " +
    "Set dryRun=true (default) to preview the estimated XPRT output, exchange rate, and fees before committing. " +
    "Set dryRun=false to execute the swap. " +
    "Preconditions: Requires wallet_setup with mnemonic (for Persistence address derivation).",
    {
      amount: z.string().describe("Amount of source token to swap (e.g. '0.1')"),
      token: z.string().default("ETH").describe("Source token symbol (default: ETH)"),
      chain: z.string().default("base").describe("Source chain (default: base)"),
      dryRun: z.boolean().default(true).describe("When true (default), returns quote/preview without executing. Set to false to execute the swap."),
      validatorAddress: z.string().optional().describe("Validator address to delegate to (auto-picks best if omitted)"),
    },
    async (params) => {
      const mnemonic = getKey("mnemonic");
      if (!mnemonic) {
        return {
          content: [{ type: "text" as const, text: `No mnemonic configured. Add MNEMONIC to ${path.resolve(getConfigDir(), ".env")} or run wallet_setup to generate new keys. Use wallet_status to check.` }],
          isError: true,
        };
      }

      // Derive persistence address to show the user where to send XPRT
      let persistenceAddress: string;
      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const cosmosWallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await cosmosWallet.getAccounts();
        persistenceAddress = account.address;
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to derive Persistence address: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }

      // Check current staking status for context
      let currentXprtStaked = 0;
      let currentTier = getMultiplierTier(0);
      try {
        const balData = await fetchJson(`${PERSISTENCE_REST}/cosmos/bank/v1beta1/balances/${persistenceAddress}`);
        const xprt = balData.balances?.find((b: any) => b.denom === "uxprt");
        currentXprtStaked = xprt ? parseInt(xprt.amount) / 1e6 : 0;
        currentTier = getMultiplierTier(currentXprtStaked);
      } catch { /* non-fatal */ }

      if (params.dryRun) {
        // Dry-run: estimate XPRT output based on CoinGecko prices
        let estimatedXprtOutput: string | null = null;
        let exchangeRate: string | null = null;
        let priceImpact: string | null = null;
        let inputValueUsd: number | null = null;

        try {
          // Fetch prices for source token and XPRT
          const tokenPriceIds: Record<string, string> = {
            ETH: "ethereum", BTC: "bitcoin", WBTC: "bitcoin", CBBTC: "bitcoin",
            USDC: "usd-coin", USDT: "tether", BNB: "binancecoin", AVAX: "avalanche-2",
            SOL: "solana", MATIC: "matic-network", POL: "matic-network",
          };
          const srcCgId = tokenPriceIds[params.token.toUpperCase()] ?? params.token.toLowerCase();
          const url = `https://api.coingecko.com/api/v3/simple/price?ids=${srcCgId},persistence&vs_currencies=usd`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const res = await fetch(url, { signal: controller.signal });
            if (res.ok) {
              const data = await res.json();
              const srcPriceUsd = data[srcCgId]?.usd;
              const xprtPriceUsd = data["persistence"]?.usd;
              if (srcPriceUsd && xprtPriceUsd && xprtPriceUsd > 0) {
                inputValueUsd = parseFloat(params.amount) * srcPriceUsd;
                // Estimate: subtract ~1% for bridge+swap fees
                const netUsd = inputValueUsd * 0.99;
                const xprtAmount = netUsd / xprtPriceUsd;
                estimatedXprtOutput = xprtAmount.toFixed(2);
                exchangeRate = `1 ${params.token} ≈ ${(srcPriceUsd / xprtPriceUsd).toFixed(2)} XPRT`;
                priceImpact = "~1% (bridge + DEX swap fees)";
              }
            }
          } finally {
            clearTimeout(timer);
          }
        } catch { /* price fetch failed — non-fatal */ }

        const newStakedTotal = estimatedXprtOutput
          ? currentXprtStaked + parseFloat(estimatedXprtOutput)
          : currentXprtStaked;
        const newTier = getMultiplierTier(newStakedTotal);

        const quoteInfo: Record<string, any> = {
          status: "dry_run",
          message: "Preview of XPRT boost — no funds committed. Set dryRun=false to execute.",
          input: {
            amount: params.amount,
            token: params.token,
            chain: params.chain,
            estimatedValueUsd: inputValueUsd ? `$${inputValueUsd.toFixed(2)}` : null,
          },
          estimatedOutput: {
            estimatedXprtOutput: estimatedXprtOutput ? `~${estimatedXprtOutput} XPRT` : "Unable to estimate (price data unavailable)",
            exchangeRate: exchangeRate ?? "Unable to estimate",
            priceImpact: priceImpact ?? "Unable to estimate",
          },
          currentState: {
            persistenceAddress,
            currentXprtStaked: currentXprtStaked.toFixed(2),
            currentTier: currentTier.tier,
            currentMultiplier: currentTier.multiplier,
          },
          projectedState: {
            projectedXprtStaked: newStakedTotal.toFixed(2),
            projectedTier: newTier.tier,
            projectedMultiplier: newTier.multiplier,
            tierChange: newTier.multiplier !== currentTier.multiplier
              ? `${currentTier.multiplier} → ${newTier.multiplier}`
              : "no change",
          },
          estimatedRoute: `${params.token} on ${params.chain} → bridge to Persistence → swap to XPRT → auto-stake`,
          feeBreakdown: {
            bridgeFee: "~0.1-0.5% (varies by route)",
            swapFee: "~0.3% (DEX swap)",
            gasFee: "~$0.50-2.00 (varies by chain)",
          },
          tiers: {
            Explorer: "0 XPRT staked → 1x multiplier",
            Voyager: "10,000 XPRT staked → 2x multiplier",
            Pioneer: "1,000,000 XPRT staked → 5x multiplier",
          },
          quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(quoteInfo, null, 2),
          }],
        };
      }

      // ── Execute mode: Bridge EVM token → XPRT → auto-stake ──────────────
      progress(`Boost execute: ${params.amount} ${params.token} on ${params.chain} → XPRT → stake`);

      // Step 1: Resolve chain and token
      const { resolveChainId } = await import("../utils/chains.js");
      const { resolveToken } = await import("../utils/token-registry.js");
      const { parseTokenAmount } = await import("../utils/tokens.js");
      const { PERSISTENCE_CHAIN_ID } = await import("../utils/chains.js");

      const fromChainId = resolveChainId(params.chain);
      if (!fromChainId) {
        return {
          content: [{ type: "text" as const, text: `Unknown chain: ${params.chain}` }],
          isError: true,
        };
      }

      const fromTokenResult = resolveToken(params.token, fromChainId);
      if (!fromTokenResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Token resolution failed: ${fromTokenResult.error}` }],
          isError: true,
        };
      }

      const toTokenResult = resolveToken("XPRT", PERSISTENCE_CHAIN_ID);
      if (!toTokenResult.ok) {
        return {
          content: [{ type: "text" as const, text: `XPRT token resolution failed: ${toTokenResult.error}` }],
          isError: true,
        };
      }

      const amountRaw = parseTokenAmount(params.amount, fromTokenResult.decimals);
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        return {
          content: [{ type: "text" as const, text: `No private key configured. Run wallet_setup first.` }],
          isError: true,
        };
      }
      const evmWallet = new ethers.Wallet(privateKey);

      // Step 2: Get Squid quote (only backend supporting EVM → Cosmos)
      progress("Getting Squid quote for EVM → XPRT...");
      const squidBackend = engine.getBackend("squid");
      if (!squidBackend) {
        return {
          content: [{ type: "text" as const, text: `Squid backend not available. Cannot bridge to Cosmos.` }],
          isError: true,
        };
      }

      const quote = await squidBackend.getQuote({
        fromChainId,
        toChainId: PERSISTENCE_CHAIN_ID,
        fromTokenAddress: fromTokenResult.address,
        toTokenAddress: toTokenResult.address,
        amountRaw,
        fromAddress: evmWallet.address,
        preference: "fastest",
        fromTokenDecimals: fromTokenResult.decimals,
        toTokenDecimals: toTokenResult.decimals,
      });

      if (!quote) {
        return {
          content: [{ type: "text" as const, text: `No Squid route found for ${params.amount} ${params.token} (${params.chain}) → XPRT. Try a different token or chain.` }],
          isError: true,
        };
      }

      progress(`Quote: ~${quote.minOutputAmount} XPRT, ETA: ${quote.estimatedTimeSeconds}s`);

      // Step 3: Build unsigned transaction
      const txRequest = await squidBackend.buildTransaction(quote);

      // Step 4: Sign and broadcast on EVM chain
      progress("Signing and broadcasting bridge tx...");
      const provider = await getProvider(fromChainId);
      const signer = evmWallet.connect(provider);

      // Check balance
      const balance = await provider.getBalance(evmWallet.address);
      if (balance < BigInt(amountRaw)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Insufficient balance",
              balance: ethers.formatEther(balance),
              required: params.amount,
              token: params.token,
              chain: params.chain,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Send approval tx if needed
      if (txRequest.approvalTx) {
        progress("Sending token approval...");
        const approvalTx = await signer.sendTransaction({
          to: txRequest.approvalTx.to,
          data: txRequest.approvalTx.data,
          value: txRequest.approvalTx.value,
          chainId: txRequest.approvalTx.chainId,
        });
        await approvalTx.wait();
        progress(`Approval confirmed: ${approvalTx.hash}`);
      }

      // Send bridge tx
      const tx = await signer.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value,
        chainId: txRequest.chainId,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
      });

      progress(`Bridge tx sent: ${tx.hash}`);
      const receipt = await tx.wait();

      if (receipt?.status !== 1) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Bridge transaction failed on-chain",
              txHash: tx.hash,
            }, null, 2),
          }],
          isError: true,
        };
      }

      progress("Bridge tx confirmed on source chain. Waiting for XPRT to arrive on Persistence...");

      // Step 5: Poll for XPRT arrival on Persistence (up to 30 minutes)
      const preLiquidBalance = await (async () => {
        try {
          const balData = await fetchJson(`https://rest.cosmos.directory/persistence/cosmos/bank/v1beta1/balances/${persistenceAddress}`);
          const xprt = balData.balances?.find((b: any) => b.denom === "uxprt");
          return parseInt(xprt?.amount || "0");
        } catch { return 0; }
      })();

      const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
      const POLL_MS = 30_000; // check every 30s
      const startTime = Date.now();
      let xprtReceived = 0;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        progress(`Waiting for XPRT... (${elapsed}s elapsed)`);

        try {
          const balData = await fetchJson(`https://rest.cosmos.directory/persistence/cosmos/bank/v1beta1/balances/${persistenceAddress}`);
          const xprt = balData.balances?.find((b: any) => b.denom === "uxprt");
          const currentBalance = parseInt(xprt?.amount || "0");
          if (currentBalance > preLiquidBalance) {
            xprtReceived = (currentBalance - preLiquidBalance) / 1e6;
            progress(`XPRT arrived! Received: ${xprtReceived.toFixed(2)} XPRT`);
            break;
          }
        } catch {
          // LCD query failed, keep polling
        }
      }

      if (xprtReceived === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "bridge_pending",
              message: "Bridge tx confirmed but XPRT hasn't arrived yet after 30 minutes. It may still be in transit via Axelar/IBC.",
              txHash: tx.hash,
              persistenceAddress,
              action: "Check wallet_balance later, then run xprt_stake manually once XPRT arrives.",
            }, null, 2),
          }],
        };
      }

      // Step 6: Auto-stake the received XPRT
      progress(`Staking ${xprtReceived.toFixed(2)} XPRT...`);
      let stakeTxHash = "not_executed";
      let stakeError: string | null = null;

      try {
        const { SigningStargateClient } = await import("@cosmjs/stargate");
        const { Secp256k1HdWallet: StakeWallet } = await import("@cosmjs/amino");
        const stakeWallet = await StakeWallet.fromMnemonic(mnemonic, { prefix: "persistence" });

        const rpc = "https://persistence-rpc.polkachu.com";
        const client = await SigningStargateClient.connectWithSigner(rpc, stakeWallet);

        // Pick validator (use provided or auto-select)
        let validatorAddr = params.validatorAddress;
        if (!validatorAddr) {
          try {
            const validatorsData = await fetchJson(`https://rest.cosmos.directory/persistence/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=100`);
            const validators = (validatorsData.validators || [])
              .filter((v: any) => !v.jailed && v.status === "BOND_STATUS_BONDED")
              .sort((a: any, b: any) => parseInt(b.tokens || "0") - parseInt(a.tokens || "0"));
            if (validators.length > 0) {
              validatorAddr = validators[0].operator_address;
              progress(`Auto-selected validator: ${validators[0].description?.moniker || validatorAddr}`);
            }
          } catch { /* fallback below */ }
        }

        if (!validatorAddr) {
          stakeError = "No validator available. XPRT received but not staked. Use xprt_stake to delegate manually.";
        } else {
          // Leave a small amount for gas (~0.1 XPRT)
          const stakeAmountUxprt = Math.floor((xprtReceived - 0.1) * 1e6);
          if (stakeAmountUxprt <= 0) {
            stakeError = "Received amount too small to stake after reserving gas. Use xprt_stake manually.";
          } else {
            const msg = {
              typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
              value: {
                delegatorAddress: persistenceAddress,
                validatorAddress: validatorAddr,
                amount: { denom: "uxprt", amount: String(stakeAmountUxprt) },
              },
            };

            const fee = { amount: [{ denom: "uxprt", amount: "5000" }], gas: "250000" };
            const result = await client.signAndBroadcast(persistenceAddress, [msg], fee, "BridgeKitty auto-stake");

            if (result.code === 0) {
              stakeTxHash = result.transactionHash;
              progress(`Staked! Tx: ${stakeTxHash}`);
            } else {
              stakeError = `Staking tx failed with code ${result.code}: ${result.rawLog}`;
            }
          }
        }
      } catch (err) {
        stakeError = `Staking failed: ${sanitizeError(err as Error)}. XPRT received but not staked — use xprt_stake manually.`;
      }

      // Calculate new tier
      const newStakedTotal = currentXprtStaked + (stakeError ? 0 : xprtReceived);
      const newTier = getMultiplierTier(newStakedTotal);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: stakeError ? "bridge_success_stake_failed" : "completed",
            message: stakeError
              ? `Successfully bridged ${params.amount} ${params.token} → ${xprtReceived.toFixed(2)} XPRT, but staking failed.`
              : `Successfully bridged ${params.amount} ${params.token} → ${xprtReceived.toFixed(2)} XPRT and auto-staked!`,
            bridgeTxHash: tx.hash,
            stakeTxHash: stakeError ? null : stakeTxHash,
            stakeError: stakeError || undefined,
            xprtReceived: xprtReceived.toFixed(2),
            persistenceAddress,
            previousMultiplier: currentTier.multiplier,
            newMultiplier: newTier.multiplier,
            newTier: newTier.tier,
            totalStaked: newStakedTotal.toFixed(2),
            warning: "⚠️ Staked XPRT is locked for 21 days if you unstake. Use xprt_unstake to initiate unbonding.",
            tiers: {
              Explorer: "0 XPRT staked → 1x multiplier",
              Voyager: "10,000 XPRT staked → 2x multiplier",
              Pioneer: "1,000,000 XPRT staked → 5x multiplier",
            },
          }, null, 2),
        }],
      };
    }
  );
}
