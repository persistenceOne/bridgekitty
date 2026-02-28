import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { PersistenceBackend } from "../backends/persistence.js";
import { getKey } from "./wallet.js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { simulateTransaction } from "../utils/tx-simulator.js";

const REWARDS_API = "https://rewards.interop.persistence.one";
const PERSISTENCE_REST = "https://rest.core.persistence.one";
const TIMEOUT_MS = 15_000;

// Token addresses
const CBTCB_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC on Base (8 decimals)
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"; // BTCB on BSC (18 decimals)

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const RPC_URLS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed1.binance.org",
};

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
  const provider = new ethers.JsonRpcProvider(RPC_URLS[chainId]);
  const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
  const bal: bigint = await contract.balanceOf(wallet);
  return bal.toString();
}

function getMultiplierTier(xprtStaked: number): { tier: string; multiplier: string } {
  if (xprtStaked >= 1_000_000) return { tier: "Pioneer", multiplier: "5x" };
  if (xprtStaked >= 10_000) return { tier: "Voyager", multiplier: "2x" };
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

async function getClampedAmount(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  decimals: number,
  userCapBtc?: number
): Promise<ClampedAmount | null> {
  const balanceRaw = BigInt(await getBalance(chainId, tokenAddress, walletAddress));
  // Normalize to 8-decimal BTC (cbBTC is 8-dec, BTCB is 18-dec)
  const balance8Dec = decimals > 8
    ? balanceRaw / (10n ** BigInt(decimals - 8))
    : balanceRaw;

  if (balance8Dec < MIN_BTC_8DEC) return null; // Below minimum

  let clamped = balance8Dec > MAX_BTC_8DEC ? MAX_BTC_8DEC : balance8Dec;
  if (userCapBtc !== undefined) {
    const cap8Dec = BigInt(Math.round(userCapBtc * 1e8));
    if (cap8Dec < clamped) clamped = cap8Dec;
  }
  if (clamped < MIN_BTC_8DEC) clamped = MIN_BTC_8DEC;

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
        return {
          content: [{ type: "text" as const, text: "PRIVATE_KEY not set. Run wallet_setup first." }],
          isError: true,
        };
      }

      const signer = new ethers.Wallet(privateKey);
      const walletAddress = signer.address;

      // Check ETH balance on Base
      const baseProvider = new ethers.JsonRpcProvider(RPC_URLS[8453]);
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
            const connectedSigner = signer.connect(new ethers.JsonRpcProvider(RPC_URLS[tx.chainId] ?? "https://mainnet.base.org"));
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
    "Start XPRT farming by running automated BTC round-trip swaps between BSC and Base via Persistence Interop. Earn XPRT rewards distributed daily as airdrops — not guaranteed income.",
    {
      amount: z.string().optional().describe("Max BTC amount per leg (e.g. '0.0003'). Omit to use full available balance each leg, clamped to protocol limits 0.00005–0.001 BTC."),
      startFrom: z.enum(["base", "bsc"]).default("base").describe("Start from 'base' (cbBTC→BTCB) or 'bsc' (BTCB→cbBTC)"),
      rounds: z.number().default(10).describe("Number of round trips (default 10)"),
      delay: z.number().default(30).describe("Delay between rounds in seconds (default 30)"),
      maxFailures: z.number().default(3).describe("Stop after N consecutive failures (default 3)"),
      maxLossBps: z.number().default(200).describe("Stop if cumulative loss exceeds N basis points (default 200 = 2%)"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        return {
          content: [{ type: "text" as const, text: "PRIVATE_KEY not set. Run wallet_setup first." }],
          isError: true,
        };
      }

      const signer = new ethers.Wallet(privateKey);
      const walletAddress = signer.address;
      const persistence = new PersistenceBackend();

      // Parse optional user cap (in BTC)
      const userCapBtc = params.amount ? parseFloat(params.amount) : undefined;

      // Compute leg configs based on startFrom direction
      const leg1: LegConfig = params.startFrom === "bsc"
        ? { chainId: 56, destChainId: 8453, token: BTCB_BSC, destToken: CBTCB_BASE, decimals: 18, label: "BSC→Base" }
        : { chainId: 8453, destChainId: 56, token: CBTCB_BASE, destToken: BTCB_BSC, decimals: 8, label: "Base→BSC" };
      const leg2: LegConfig = params.startFrom === "bsc"
        ? { chainId: 8453, destChainId: 56, token: CBTCB_BASE, destToken: BTCB_BSC, decimals: 8, label: "Base→BSC" }
        : { chainId: 56, destChainId: 8453, token: BTCB_BSC, destToken: CBTCB_BASE, decimals: 18, label: "BSC→Base" };

      const results: Array<{
        round: number;
        leg1?: { txHash: string; orderId: string; status: string; amountBtc?: string };
        leg2?: { txHash: string; orderId: string; status: string; amountBtc?: string };
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

      for (let i = 0; i < params.rounds; i++) {
        if (consecutiveFailures >= params.maxFailures) break;
        if (totalLossBps >= params.maxLossBps) break;

        const roundResult: (typeof results)[number] = { round: i + 1 };
        let roundFailed = false;

        // ── Leg 1 ──────────────────────────────────────────────────────
        try {
          const clamped1 = await getClampedAmount(
            leg1.chainId, leg1.token, walletAddress, leg1.decimals, userCapBtc
          );
          if (!clamped1) throw new Error(`Balance below minimum 0.00005 BTC on ${leg1.label.split("→")[0]}`);

          const quote1 = await persistence.getQuote({
            fromChainId: leg1.chainId, toChainId: leg1.destChainId,
            fromTokenAddress: leg1.token, toTokenAddress: leg1.destToken,
            amountRaw: clamped1.amountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote1) throw new Error(`No quote available for ${leg1.label}`);

          const result1 = await persistence.signAndExecute(quote1, signer);
          roundResult.leg1 = {
            txHash: result1.txHash, orderId: result1.orderId, status: "submitted",
            amountBtc: `${Number(clamped1.btc8Dec) / 1e8}`,
          };

          let fulfilled = false;
          for (let w = 0; w < 30; w++) {
            await new Promise(r => setTimeout(r, 10_000));
            const status = await persistence.getStatus(result1.trackingId, { orderId: result1.orderId });
            if (status.state === "completed") { fulfilled = true; break; }
            if (status.state === "failed") break;
          }
          if (!fulfilled) {
            roundResult.leg1.status = "timeout";
            roundFailed = true;
          } else {
            roundResult.leg1.status = "completed";
          }
        } catch (err) {
          roundResult.leg1 = { txHash: "", orderId: "", status: `failed: ${sanitizeError(err as Error)}` };
          roundFailed = true;
        }

        if (roundFailed) {
          results.push(roundResult);
          consecutiveFailures++;
          continue;
        }

        await new Promise(r => setTimeout(r, 5_000));

        // ── Leg 2 ──────────────────────────────────────────────────────
        try {
          const clamped2 = await getClampedAmount(
            leg2.chainId, leg2.token, walletAddress, leg2.decimals, userCapBtc
          );
          if (!clamped2) throw new Error(`Balance below minimum 0.00005 BTC on ${leg2.label.split("→")[0]}`);

          const quote2 = await persistence.getQuote({
            fromChainId: leg2.chainId, toChainId: leg2.destChainId,
            fromTokenAddress: leg2.token, toTokenAddress: leg2.destToken,
            amountRaw: clamped2.amountRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote2) throw new Error(`No quote available for ${leg2.label}`);

          const result2 = await persistence.signAndExecute(quote2, signer);
          roundResult.leg2 = {
            txHash: result2.txHash, orderId: result2.orderId, status: "submitted",
            amountBtc: `${Number(clamped2.btc8Dec) / 1e8}`,
          };

          let fulfilled = false;
          for (let w = 0; w < 30; w++) {
            await new Promise(r => setTimeout(r, 10_000));
            const status = await persistence.getStatus(result2.trackingId, { orderId: result2.orderId });
            if (status.state === "completed") { fulfilled = true; break; }
            if (status.state === "failed") break;
          }
          roundResult.leg2.status = fulfilled ? "completed" : "timeout";
          if (fulfilled) {
            completedRounds++;
            consecutiveFailures = 0;
            // Track cumulative loss: compare home-chain balance vs start
            try {
              if (initialHomeBalance8Dec !== null && initialHomeBalance8Dec > 0n) {
                const homeBal = BigInt(await getBalance(leg1.chainId, leg1.token, walletAddress));
                const current8Dec = leg1.decimals > 8
                  ? homeBal / (10n ** BigInt(leg1.decimals - 8))
                  : homeBal;
                if (current8Dec < initialHomeBalance8Dec) {
                  const lossBps = Number(
                    ((initialHomeBalance8Dec - current8Dec) * 10000n) / initialHomeBalance8Dec
                  );
                  totalLossBps = lossBps; // cumulative from start
                }
              }
            } catch { /* balance check failed — non-fatal, skip loss tracking */ }
          } else {
            consecutiveFailures++;
          }
        } catch (err) {
          roundResult.leg2 = { txHash: "", orderId: "", status: `failed: ${sanitizeError(err as Error)}` };
          consecutiveFailures++;
        }

        results.push(roundResult);

        if (i < params.rounds - 1 && consecutiveFailures < params.maxFailures) {
          await new Promise(r => setTimeout(r, params.delay * 1000));
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "completed",
            wallet: walletAddress,
            direction: params.startFrom === "bsc" ? "BSC→Base→BSC" : "Base→BSC→Base",
            amountMode: userCapBtc ? `capped at ${userCapBtc} BTC` : "max available (clamped to 0.00005–0.001 BTC)",
            completedRounds,
            totalAttempted: results.length,
            totalLossBps,
            stoppedEarly: consecutiveFailures >= params.maxFailures ? "max consecutive failures" :
              totalLossBps >= params.maxLossBps ? "max loss threshold" : null,
            rounds: results,
            disclaimer: "Rewards are estimated and not guaranteed.",
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
          content: [{ type: "text" as const, text: "PRIVATE_KEY not set. Run wallet_setup first." }],
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
    "Buy XPRT with any token and auto-stake for XPRT farming multiplier boost. One command to go from 1x to 2x or 5x multiplier.",
    {
      amount: z.string().describe("Amount of source token to swap (e.g. '0.1')"),
      token: z.string().default("ETH").describe("Source token symbol (default: ETH)"),
      chain: z.string().default("base").describe("Source chain (default: base)"),
      validatorAddress: z.string().optional().describe("Validator address to delegate to (auto-picks best if omitted)"),
    },
    async (params) => {
      const mnemonic = getKey("mnemonic");
      if (!mnemonic) {
        return {
          content: [{ type: "text" as const, text: "MNEMONIC required. Run wallet_setup first." }],
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

      // TODO: Add automated EVM → Persistence XPRT swap via Skip Protocol IBC route
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "manual_required",
            message: "To boost your XPRT farming multiplier, acquire XPRT and send it to your Persistence address:",
            steps: [
              `1. Buy XPRT on Osmosis DEX, Gate.io, or Huobi`,
              `2. Send XPRT to your Persistence address: ${persistenceAddress}`,
              `3. Run xprt_farm_boost again after funding — it will auto-stake your XPRT`,
            ],
            persistenceAddress,
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
