import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getKey, getConfigDir } from "./wallet.js";
import { ethers } from "ethers";
import * as path from "path";

const REWARDS_API = "https://rewards.interop.persistence.one";
const PERSISTENCE_REST = "https://rest.cosmos.directory/persistence";
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
        result.totalXprtEarned = rewardData.totalXprtEarned ?? "not_yet_tracked";
        result.pendingXprtRewards = rewardData.pendingXprtRewards ?? "pending_epoch_close";
        result.nextDistributionDate = rewardData.nextDistributionDate ?? "pending_epoch_close";
        result.qualifyingVolumeBtc = rewardData.qualifyingVolumeBtc ?? "no_qualifying_volume";
        result.lifetimeVolumeBtc = rewardData.lifetimeVolumeBtc ?? "no_volume_recorded";
      } catch {
        result.totalXprtEarned = "not_yet_tracked";
        result.pendingXprtRewards = "pending_epoch_close";
        result.nextDistributionDate = "pending_epoch_close";
        result.qualifyingVolumeBtc = "no_qualifying_volume";
        result.lifetimeVolumeBtc = "no_volume_recorded";
      }

      // Fetch current epoch data
      try {
        const epochData = await fetchJson(`${REWARDS_API}/epochs/current`);
        const currentEpoch: any = {
          epochNumber: epochData.epochNumber ?? "not_available",
          startDate: epochData.startDate ?? "not_available",
          endDate: epochData.endDate ?? "not_available",
          status: epochData.status ?? "not_available",
          rewardPoolXprt: epochData.rewardPoolXprt
            ? `~${Number(epochData.rewardPoolXprt).toFixed(2)} XPRT`
            : "not_available",
        };

        // Calculate time remaining if endDate is available
        if (epochData.endDate && epochData.endDate !== "not_available") {
          try {
            const endTime = new Date(epochData.endDate).getTime();
            const now = Date.now();
            if (endTime > now) {
              const diffMs = endTime - now;
              const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
              const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
              currentEpoch.endsIn = `${diffHours}h ${diffMinutes}m`;
            } else {
              currentEpoch.endsIn = "epoch_closed";
            }
          } catch {
            currentEpoch.endsIn = "calculation_failed";
          }
        } else {
          currentEpoch.endsIn = "end_time_unknown";
        }

        result.currentEpoch = currentEpoch;
      } catch {
        result.currentEpoch = {
          epochNumber: "api_unavailable",
          status: "api_unavailable",
          endsIn: "api_unavailable",
        };
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

      // Fetch multiplier and staking info from leaderboard API (authoritative source)
      try {
        const epochNumber = result.currentEpoch?.epochNumber;
        if (epochNumber && epochNumber !== "not_available" && epochNumber !== "api_unavailable") {
          const leaderboardData = await fetchJson(`${REWARDS_API}/leaderboard?epoch=${epochNumber}`);
          const entries = Array.isArray(leaderboardData) ? leaderboardData : leaderboardData.data ?? leaderboardData.leaderboard ?? [];
          const entry = entries.find((e: any) =>
            e.walletAddress?.toLowerCase() === evmAddress!.toLowerCase() ||
            e.evmAddress?.toLowerCase() === evmAddress!.toLowerCase() ||
            e.address?.toLowerCase() === evmAddress!.toLowerCase()
          );

          if (entry) {
            result.currentMultiplier = entry.rewardMultiplier ? `${entry.rewardMultiplier}x` : entry.multiplier ?? "1x";
            result.rank = entry.rank ?? null;
            result.tier = entry.tier ?? null;
            result.bridgedVolumeUsd = entry.bridgedVolumeUsd ?? entry.volumeUsd ?? null;
            result.rewardPoints = entry.rewardPoints ?? entry.points ?? null;
            result.txCount = entry.txCount ?? entry.transactionCount ?? null;
            result.estimatedRewardXprt = entry.estimatedReward ?? entry.estimatedRewardXprt ?? null;

            result.stakingInfo = {
              stakedXprt: entry.xprtStaked ?? entry.stakedXprt ?? "unknown",
              isStaker: entry.isStaker ?? null,
              multiplierFromLeaderboard: result.currentMultiplier,
              note: "Multiplier sourced from leaderboard API"
            };
          } else {
            result.currentMultiplier = "1x";
            result.stakingInfo = { note: "Wallet not found in current epoch leaderboard" };
          }
        } else {
          result.currentMultiplier = "not_yet_determined";
        }
      } catch {
        // Fallback: try staking data directly
        const mnemonic = getKey("mnemonic");
        if (mnemonic) {
          try {
            const { Secp256k1HdWallet } = await import("@cosmjs/amino");
            const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
            const [account] = await wallet.getAccounts();
            const persistenceAddress = account.address;
            const delegationsData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/delegations/${persistenceAddress}`);

            let totalStaked = 0;
            if (delegationsData.delegation_responses) {
              for (const del of delegationsData.delegation_responses) {
                totalStaked += parseInt(del.balance?.amount || "0");
              }
            }

            result.stakingInfo = {
              stakedXprt: (totalStaked / 1e6).toFixed(2),
              note: "Multiplier unavailable — leaderboard API failed. Staking data from chain."
            };
            result.currentMultiplier = "unknown (leaderboard unavailable)";
          } catch {
            result.currentMultiplier = "unknown";
          }
        } else {
          result.currentMultiplier = "unknown";
        }
      }

      result.estimatedRewardNote = "Rewards depend on total participation in each epoch. Estimates may change based on network-wide bridging volume and staking multipliers.";
      result.disclaimer = "Rewards are estimated and not guaranteed. Actual rewards distributed after epoch close.";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
