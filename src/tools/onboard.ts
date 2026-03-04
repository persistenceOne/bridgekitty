import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingEngine } from "../routing/engine.js";
import { getKey, getConfigDir } from "./wallet.js";
import { ethers } from "ethers";
import { getProvider } from "../utils/gas-estimator.js";
import * as path from "path";

const REWARDS_API = "https://rewards.interop.persistence.one";
const TIMEOUT_MS = 15_000;

const CBTCB_BASE = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC on Base (8 decimals)
const BTCB_BSC = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"; // BTCB on BSC (18 decimals)

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

interface OnboardStep {
  step: number;
  action: string;
  tool: string;
  suggestedParams?: Record<string, any>;
  explanation: string;
}

export function registerOnboardTool(server: McpServer, engine: RoutingEngine) {
  server.tool(
    "xprt_onboard",
    "Personalized onboarding for XPRT farming. Detects current wallet state and returns an ordered " +
    "action plan to go from your current position to actively farming XPRT rewards.",
    {},
    async () => {
      // Step 0: Check if wallet is configured
      const privateKey = getKey("privateKey");
      if (!privateKey) {
        const envPath = path.resolve(getConfigDir(), ".env");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "wallet_needed",
              steps: [{
                step: 1,
                action: "Set up a wallet",
                tool: "wallet_setup",
                suggestedParams: {},
                explanation: "You need a wallet before you can start farming. wallet_setup will generate keys for EVM, Cosmos, and Solana chains and save them securely.",
              }],
              nextAction: "Run wallet_setup to create your wallet, then run xprt_onboard again.",
              configPath: envPath,
            }, null, 2),
          }],
        };
      }

      const wallet = new ethers.Wallet(privateKey);
      const evmAddress = wallet.address;
      const steps: OnboardStep[] = [];
      let stepNum = 1;

      // Gather wallet state in parallel
      const balanceChecks = await Promise.allSettled([
        // ETH on Base (for gas)
        (async () => {
          const provider = await getProvider(8453);
          const bal = await provider.getBalance(evmAddress);
          return { key: "ethBase", value: parseFloat(ethers.formatEther(bal)) };
        })(),
        // cbBTC on Base
        (async () => {
          const provider = await getProvider(8453);
          const contract = new ethers.Contract(CBTCB_BASE, ERC20_BALANCE_ABI, provider);
          const bal: bigint = await contract.balanceOf(evmAddress);
          return { key: "cbbtcBase", value: parseFloat(ethers.formatUnits(bal, 8)) };
        })(),
        // BTCB on BSC
        (async () => {
          const provider = await getProvider(56);
          const contract = new ethers.Contract(BTCB_BSC, ERC20_BALANCE_ABI, provider);
          const bal: bigint = await contract.balanceOf(evmAddress);
          return { key: "btcbBsc", value: parseFloat(ethers.formatUnits(bal, 18)) };
        })(),
        // BNB on BSC (for gas)
        (async () => {
          const provider = await getProvider(56);
          const bal = await provider.getBalance(evmAddress);
          return { key: "bnbBsc", value: parseFloat(ethers.formatEther(bal)) };
        })(),
      ]);

      const balances: Record<string, number> = {
        ethBase: 0,
        cbbtcBase: 0,
        btcbBsc: 0,
        bnbBsc: 0,
      };

      for (const result of balanceChecks) {
        if (result.status === "fulfilled") {
          balances[result.value.key] = result.value.value;
        }
      }

      // Check Persistence address link status
      let isLinked = false;
      let persistenceAddress: string | undefined;
      try {
        const linkData = await fetchJson(
          `${REWARDS_API}/address-verification/check/${evmAddress}`
        );
        isLinked = linkData.isRegistered ?? false;
        persistenceAddress = linkData.persistenceAddress;
      } catch {
        // Non-fatal -- we'll suggest linking anyway
      }

      // Build personalized steps based on state

      // Step: Need ETH on Base for gas
      const needsBaseGas = balances.ethBase < 0.003;
      const hasCbbtc = balances.cbbtcBase >= 0.00005;
      const hasBtcb = balances.btcbBsc >= 0.00005;
      const needsBscGas = balances.bnbBsc < 0.001;
      const hasBtcAnywhere = hasCbbtc || hasBtcb;

      if (needsBaseGas && !hasBtcAnywhere) {
        // User has nothing -- need to fund wallet first
        steps.push({
          step: stepNum++,
          action: "Fund your wallet with ETH on Base",
          tool: "wallet_balance",
          suggestedParams: { chains: ["base"] },
          explanation: `Send at least 0.005 ETH to ${evmAddress} on Base (chain ID 8453). This covers gas fees and will be partially converted to cbBTC for farming. Current balance: ${balances.ethBase.toFixed(6)} ETH.`,
        });
      }

      if (!needsBaseGas && !hasBtcAnywhere) {
        // Has ETH but no BTC -- needs to prepare
        steps.push({
          step: stepNum++,
          action: "Convert ETH to cbBTC and bridge gas to BSC",
          tool: "xprt_farm_prepare",
          suggestedParams: {},
          explanation: `You have ${balances.ethBase.toFixed(6)} ETH on Base. xprt_farm_prepare will swap some to cbBTC for farming and bridge a small amount to BSC for gas.`,
        });
      }

      if (hasBtcAnywhere && needsBscGas) {
        // Has BTC but no BSC gas
        steps.push({
          step: stepNum++,
          action: "Bridge some ETH to BSC for gas",
          tool: "bridge_get_quote",
          suggestedParams: {
            fromChain: "base",
            toChain: "bsc",
            fromToken: "ETH",
            toToken: "BNB",
            amount: "0.0002",
            fromAddress: evmAddress,
          },
          explanation: `You need BNB on BSC for gas fees during farming round-trips. Current BNB balance: ${balances.bnbBsc.toFixed(6)}. Bridge a small amount of ETH to BNB.`,
        });
      }

      if (hasBtcAnywhere && !needsBscGas) {
        // Ready to farm
        steps.push({
          step: stepNum++,
          action: "Start XPRT farming",
          tool: "xprt_farm_start",
          suggestedParams: {
            rounds: 5,
            startFrom: "auto",
          },
          explanation: `You have ${hasCbbtc ? balances.cbbtcBase.toFixed(8) + " cbBTC on Base" : ""}${hasCbbtc && hasBtcb ? " and " : ""}${hasBtcb ? balances.btcbBsc.toFixed(8) + " BTCB on BSC" : ""}. Ready to start round-trip farming to earn XPRT rewards.`,
        });
      }

      if (!isLinked) {
        steps.push({
          step: stepNum++,
          action: "Link your Persistence address for rewards",
          tool: "xprt_farm_status",
          suggestedParams: {},
          explanation: "Link your EVM wallet to a Persistence address so XPRT rewards can be distributed to your Cosmos wallet. Run xprt_farm_status to check link status and follow the instructions.",
        });
      }

      // Always suggest boost as optional final step
      steps.push({
        step: stepNum++,
        action: "Optional: Stake XPRT for multiplier boost",
        tool: "xprt_farm_boost",
        suggestedParams: {},
        explanation: "Stake XPRT on Persistence chain to increase your farming multiplier. Tiers: Explorer (1x, 0 XPRT), Voyager (2x, 10K XPRT), Pioneer (5x, 1M XPRT).",
      });

      // Determine overall readiness
      let readiness: string;
      if (!needsBaseGas && hasBtcAnywhere && !needsBscGas) {
        readiness = "ready_to_farm";
      } else if (!needsBaseGas && !hasBtcAnywhere) {
        readiness = "needs_btc_conversion";
      } else if (hasBtcAnywhere && needsBscGas) {
        readiness = "needs_bsc_gas";
      } else {
        readiness = "needs_funding";
      }

      const response: Record<string, any> = {
        status: readiness,
        wallet: evmAddress,
        currentBalances: {
          "ETH (Base)": `${balances.ethBase.toFixed(6)} ETH`,
          "cbBTC (Base)": `${balances.cbbtcBase.toFixed(8)} BTC`,
          "BTCB (BSC)": `${balances.btcbBsc.toFixed(8)} BTC`,
          "BNB (BSC)": `${balances.bnbBsc.toFixed(6)} BNB`,
        },
        persistenceLinked: isLinked,
        steps,
        estimatedYield: "XPRT rewards are distributed daily based on your bridging volume and multiplier tier. Estimated, not guaranteed.",
      };

      if (persistenceAddress) {
        response.persistenceAddress = persistenceAddress;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        }],
      };
    }
  );
}
