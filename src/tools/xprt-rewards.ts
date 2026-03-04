import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getKey, getConfigDir } from "./wallet.js";
import { ethers } from "ethers";
import * as path from "path";

const REWARDS_API = "https://rewards.interop.persistence.one";
const TIMEOUT_MS = 15_000;

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

export function registerXprtRewardsCheck(server: McpServer) {
  server.tool(
    "xprt_rewards_check",
    "Check your XPRT reward accrual from Persistence Interop bridging. Shows earned rewards, pending rewards, current epoch, multiplier tier, and qualifying volume.",
    {
      walletAddress: z
        .string()
        .optional()
        .describe("EVM wallet address (0x...). Defaults to the configured wallet if omitted."),
    },
    async (params) => {
      // Resolve wallet address
      let evmAddress = params.walletAddress;
      if (!evmAddress) {
        const privateKey = getKey("privateKey");
        if (!privateKey) {
          const envPath = path.resolve(getConfigDir(), ".env");
          return {
            content: [{
              type: "text" as const,
              text: `No wallet configured and no walletAddress provided. Add keys to ${envPath} (MNEMONIC=... / PRIVATE_KEY=0x...) or run wallet_setup, or pass walletAddress parameter.`,
            }],
            isError: true,
          };
        }
        evmAddress = new ethers.Wallet(privateKey).address;
      }

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid EVM address format: ${evmAddress}. Expected 0x-prefixed 40-character hex string.`,
          }],
          isError: true,
        };
      }

      const result: Record<string, any> = {
        wallet: evmAddress,
      };

      // Fetch reward data
      try {
        const rewardData = await fetchJson(`${REWARDS_API}/rewards/${evmAddress}`);
        result.totalXprtEarned = rewardData.totalXprtEarned ?? "unknown";
        result.pendingXprtRewards = rewardData.pendingXprtRewards ?? "unknown";
        result.nextDistributionDate = rewardData.nextDistributionDate ?? "unknown";
        result.currentMultiplier = rewardData.currentMultiplier ?? "unknown";
        result.qualifyingVolumeBtc = rewardData.qualifyingVolumeBtc ?? "unknown";
        result.lifetimeVolumeBtc = rewardData.lifetimeVolumeBtc ?? "unknown";
      } catch {
        result.totalXprtEarned = "unknown";
        result.pendingXprtRewards = "unknown";
        result.nextDistributionDate = "unknown";
        result.currentMultiplier = "unknown";
        result.qualifyingVolumeBtc = "unknown";
        result.lifetimeVolumeBtc = "unknown";
      }

      // Fetch current epoch data
      try {
        const epochData = await fetchJson(`${REWARDS_API}/epochs/current`);
        result.currentEpoch = {
          epochNumber: epochData.epochNumber ?? "unknown",
          startDate: epochData.startDate ?? "unknown",
          endDate: epochData.endDate ?? "unknown",
          status: epochData.status ?? "unknown",
          rewardPoolXprt: epochData.rewardPoolXprt
            ? `~${Number(epochData.rewardPoolXprt).toFixed(2)} XPRT`
            : "unknown",
        };
      } catch {
        result.currentEpoch = "unknown";
      }

      // Fetch address link status
      try {
        const linkData = await fetchJson(
          `${REWARDS_API}/address-verification/check/${evmAddress}`
        );
        result.persistenceAddressLinked = linkData.isRegistered ?? false;
        if (linkData.persistenceAddress) {
          result.persistenceAddress = linkData.persistenceAddress;
        }
      } catch {
        result.persistenceAddressLinked = "unknown";
      }

      result.disclaimer = "Rewards are estimated and not guaranteed.";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
