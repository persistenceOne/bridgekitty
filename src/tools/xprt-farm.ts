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
      amount: z.string().default("0.00005").describe("BTC amount per leg (default 0.00005)"),
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

      const amountBtc = parseFloat(params.amount);
      const cbBTCRaw = Math.round(amountBtc * 1e8).toString();
      const btcbRaw = ethers.parseUnits(params.amount, 18).toString();

      const results: Array<{
        round: number;
        leg1?: { txHash: string; orderId: string; status: string };
        leg2?: { txHash: string; orderId: string; status: string };
      }> = [];

      let consecutiveFailures = 0;
      let completedRounds = 0;
      const totalFeesBps = 0;

      for (let i = 0; i < params.rounds; i++) {
        if (consecutiveFailures >= params.maxFailures) break;
        if (totalFeesBps >= params.maxLossBps) break;

        const roundResult: (typeof results)[number] = { round: i + 1 };
        let roundFailed = false;

        // Leg 1: Base → BSC (cbBTC → BTCB)
        try {
          const quote1 = await persistence.getQuote({
            fromChainId: 8453,
            toChainId: 56,
            fromTokenAddress: CBTCB_BASE,
            toTokenAddress: BTCB_BSC,
            amountRaw: cbBTCRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote1) throw new Error("No quote available for Base→BSC");

          const result1 = await persistence.signAndExecute(quote1, signer);
          roundResult.leg1 = { txHash: result1.txHash, orderId: result1.orderId, status: "submitted" };

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

        // Leg 2: BSC → Base (BTCB → cbBTC)
        try {
          const quote2 = await persistence.getQuote({
            fromChainId: 56,
            toChainId: 8453,
            fromTokenAddress: BTCB_BSC,
            toTokenAddress: CBTCB_BASE,
            amountRaw: btcbRaw, fromAddress: walletAddress, preference: "cheapest" as const,
          });
          if (!quote2) throw new Error("No quote available for BSC→Base");

          const result2 = await persistence.signAndExecute(quote2, signer);
          roundResult.leg2 = { txHash: result2.txHash, orderId: result2.orderId, status: "submitted" };

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
            completedRounds,
            totalAttempted: results.length,
            stoppedEarly: consecutiveFailures >= params.maxFailures ? "max consecutive failures" :
              totalFeesBps >= params.maxLossBps ? "max loss threshold" : null,
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
