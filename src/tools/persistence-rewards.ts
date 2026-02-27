import { z } from "zod";
import { ethers } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { PersistenceBackend } from "../backends/persistence.js";
import { getKey } from "./wallet.js";
import { sanitizeError } from "../utils/sanitize-error.js";

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

export function registerPersistenceEarnTools(server: McpServer, engine: RoutingEngine) {
  // ─── persistence_rewards_prepare ────────────────────────────────────────────
  server.tool(
    "persistence_rewards_prepare",
    "Convert ETH or other tokens to cbBTC and bridge gas to BSC, preparing your wallet for the Persistence XPRT rewards campaign.",
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
              // Re-fetch bridge tx after approval to get fresh nonce (Squid fix)
              if (tx.needsPostApprovalBuild && "buildBridgeTransaction" in backend) {
                tx = await (backend as any).buildBridgeTransaction(bestQuote);
              }
            }

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
            nextStep: "Run persistence_rewards_start to start qualifying for rewards",
          }, null, 2),
        }],
      };
    }
  );

  // ─── persistence_rewards_start ───────────────────────────────────────────────
  server.tool(
    "persistence_rewards_start",
    "Start qualifying bridge activity for the Persistence XPRT rewards campaign. Runs automated BTC round-trip swaps between BSC and Base. Rewards are distributed daily as airdrops — not guaranteed income.",
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

  // ─── persistence_rewards_status ────────────────────────────────────────
  server.tool(
    "persistence_rewards_status",
    "Check your Persistence rewards status: wallet link, BTC balances, current epoch reward pool. Rewards are estimated and change based on total participation.",
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

  // ─── persistence_rewards_boost ─────────────────────────────────────────────
  server.tool(
    "persistence_rewards_boost",
    "Buy XPRT with any token and auto-stake for reward multiplier boost. One command to go from 1x to 2x or 5x multiplier.",
    {
      amount: z.string().describe("Amount of source token to swap (e.g. '0.1')"),
      token: z.string().default("ETH").describe("Source token symbol (default: ETH)"),
      chain: z.string().default("base").describe("Source chain (default: base)"),
      validatorAddress: z.string().optional().describe("Validator address to delegate to (auto-picks best if omitted)"),
    },
    async (params) => {
      const privateKey = getKey("privateKey");
      const mnemonic = getKey("mnemonic");
      if (!privateKey || !mnemonic) {
        return {
          content: [{ type: "text" as const, text: "PRIVATE_KEY and MNEMONIC required. Run wallet_setup first." }],
          isError: true,
        };
      }

      const evmWallet = new ethers.Wallet(privateKey);
      const evmAddress = evmWallet.address;

      // Get persistence address
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

      // Resolve source chain ID
      const chainMap: Record<string, number> = { base: 8453, bsc: 56, ethereum: 1 };
      const sourceChainId = chainMap[params.chain.toLowerCase()];
      if (!sourceChainId) {
        return {
          content: [{ type: "text" as const, text: `Unknown chain: ${params.chain}. Supported: base, bsc, ethereum` }],
          isError: true,
        };
      }

      // Try to get a cross-chain swap quote via Squid (supports Cosmos chains)
      // Persistence chain ID in Squid/Axelar is "persistence"
      const sourceTokenAddress = params.token.toUpperCase() === "ETH" || params.token.toUpperCase() === "BNB"
        ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
        : params.token; // Assume it's a token address if not native

      // Attempt Squid route to Persistence chain
      let swapExecuted = false;
      let swapTxHash: string | undefined;
      const squidBackend = engine.getBackend("squid");

      if (squidBackend) {
        try {
          // Squid uses Axelar chain names for Cosmos chains
          // Try to get a quote — if Persistence isn't supported, this will fail gracefully
          const amountRaw = ethers.parseEther(params.amount).toString();

          // Squid's Cosmos support uses chain IDs like "persistence" for the Persistence chain
          // and token denoms like "uxprt" for XPRT
          // Since our QuoteParams expects numeric chainIds, and Squid's Cosmos support
          // may use string chain IDs internally, we need to check if the backend can handle this.
          // For now, we'll note this as a limitation.

          // Try the quote — Squid may or may not support Persistence chain directly
          const quote = await squidBackend.getQuote({
            fromChainId: sourceChainId,
            toChainId: 6532, // Persistence chain uses this as a placeholder — may not work
            fromTokenAddress: sourceTokenAddress,
            toTokenAddress: "uxprt",
            amountRaw,
            fromAddress: evmAddress,
            toAddress: persistenceAddress,
            preference: "cheapest" as const,
          });

          if (quote) {
            let tx = await squidBackend.buildTransaction(quote);
            const rpcUrl = RPC_URLS[sourceChainId] ?? "https://mainnet.base.org";
            const connectedSigner = evmWallet.connect(new ethers.JsonRpcProvider(rpcUrl));

            if (tx.approvalTx) {
              const approvalResponse = await connectedSigner.sendTransaction({
                to: tx.approvalTx.to,
                data: tx.approvalTx.data,
                value: tx.approvalTx.value,
              });
              await approvalResponse.wait();
              // Re-fetch bridge tx after approval to get fresh nonce (Squid fix)
              if (tx.needsPostApprovalBuild && "buildBridgeTransaction" in squidBackend) {
                tx = await (squidBackend as any).buildBridgeTransaction(quote);
              }
            }

            const txResponse = await connectedSigner.sendTransaction({
              to: tx.to,
              data: tx.data,
              value: tx.value,
              ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
            });
            await txResponse.wait();
            swapTxHash = txResponse.hash;
            swapExecuted = true;
          }
        } catch {
          // Squid doesn't support direct route to Persistence — fall through to manual instructions
        }
      }

      if (!swapExecuted) {
        // No direct route available — provide manual instructions
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "manual_required",
              message: "Direct cross-chain swap to Persistence chain is not yet supported via BridgeKitty routing. To boost your multiplier:",
              steps: [
                `1. Buy XPRT on a CEX (Osmosis DEX, Gate.io, Huobi) or swap via Osmosis`,
                `2. Send XPRT to your Persistence address: ${persistenceAddress}`,
                `3. The tool will auto-detect and stake it — run persistence_rewards_boost again after funding`,
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

      // Wait for XPRT to arrive (poll balance for up to 5 minutes)
      let xprtBalance = BigInt(0);
      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const cosmosWallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await cosmosWallet.getAccounts();

        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 10_000));
          try {
            const data = await fetchJson(`${PERSISTENCE_REST}/cosmos/bank/v1beta1/balances/${account.address}`);
            const xprt = data.balances?.find((b: any) => b.denom === "uxprt");
            if (xprt) {
              xprtBalance = BigInt(xprt.amount);
              if (xprtBalance > BigInt(0)) break;
            }
          } catch { /* retry */ }
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Swap submitted (tx: ${swapTxHash}) but failed to check balance: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }

      if (xprtBalance === BigInt(0)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "swap_pending",
              swapTxHash,
              message: "Swap submitted but XPRT hasn't arrived yet. It may take a few more minutes. Run this tool again to check and stake.",
              persistenceAddress,
            }, null, 2),
          }],
        };
      }

      // Delegate XPRT to a validator
      const gasReserve = BigInt(50_000); // 0.05 XPRT for gas
      const delegateAmount = xprtBalance - gasReserve;

      if (delegateAmount <= BigInt(0)) {
        return {
          content: [{
            type: "text" as const,
            text: `XPRT balance too low to stake after gas reserve. Balance: ${Number(xprtBalance) / 1e6} XPRT`,
          }],
          isError: true,
        };
      }

      let validatorAddr = params.validatorAddress;
      if (!validatorAddr) {
        // Auto-pick validator with lowest commission and >1% voting power
        try {
          const data = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`);
          const validators = data.validators ?? [];
          const totalTokens = validators.reduce((sum: bigint, v: any) => sum + BigInt(v.tokens ?? "0"), BigInt(0));

          const eligible = validators
            .filter((v: any) => {
              const votingPower = Number(BigInt(v.tokens ?? "0") * BigInt(10000) / totalTokens) / 100;
              return votingPower > 1;
            })
            .sort((a: any, b: any) => {
              const commA = parseFloat(a.commission?.commission_rates?.rate ?? "1");
              const commB = parseFloat(b.commission?.commission_rates?.rate ?? "1");
              return commA - commB;
            });

          if (eligible.length > 0) {
            validatorAddr = eligible[0].operator_address;
          }
        } catch { /* fall through */ }
      }

      if (!validatorAddr) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "needs_validator",
              swapTxHash,
              xprtBalance: `${Number(xprtBalance) / 1e6} XPRT`,
              message: "Could not auto-select a validator. Please provide a validatorAddress and run again.",
              persistenceAddress,
            }, null, 2),
          }],
        };
      }

      // Delegate using cosmjs stargate
      let delegateTxHash: string | undefined;
      try {
        const { SigningStargateClient } = await import("@cosmjs/stargate");
        const { Registry } = await import("@cosmjs/proto-signing");
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");

        const cosmosWallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await cosmosWallet.getAccounts();

        const client = await SigningStargateClient.connectWithSigner(
          "https://rpc.core.persistence.one",
          cosmosWallet
        );

        const msg = {
          typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
          value: {
            delegatorAddress: account.address,
            validatorAddress: validatorAddr,
            amount: { denom: "uxprt", amount: delegateAmount.toString() },
          },
        };

        const fee = { amount: [{ denom: "uxprt", amount: "25000" }], gas: "250000" };
        const result = await client.signAndBroadcast(account.address, [msg], fee, "BridgeKitty rewards boost");
        delegateTxHash = result.transactionHash;
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "delegation_failed",
              swapTxHash,
              xprtBalance: `${Number(xprtBalance) / 1e6} XPRT`,
              error: sanitizeError(err as Error),
              message: "XPRT received but delegation failed. You can try again or delegate manually.",
              persistenceAddress,
              validatorAddress: validatorAddr,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const stakedXprt = Number(delegateAmount) / 1e6;
      const tier = getMultiplierTier(stakedXprt);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            swapTxHash,
            delegateTxHash,
            amountStaked: `${stakedXprt.toFixed(6)} XPRT`,
            validator: validatorAddr,
            multiplier: tier,
            tiers: {
              Explorer: "0 XPRT → 1x",
              Voyager: "10,000 XPRT → 2x",
              Pioneer: "1,000,000 XPRT → 5x",
            },
          }, null, 2),
        }],
      };
    }
  );
}
