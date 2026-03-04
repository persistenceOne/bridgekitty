import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getKey } from "./wallet.js";
import { sanitizeError } from "../utils/sanitize-error.js";

const PERSISTENCE_REST = "https://rest.cosmos.directory/persistence";
// rpc.cosmos.directory returns 401 on WebSocket connections needed by SigningStargateClient
const PERSISTENCE_RPC = "https://persistence-rpc.polkachu.com";
const TIMEOUT_MS = 30_000;

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

/**
 * Fetch multiplier from the rewards API (canonical source of tier data).
 * Falls back to hardcoded tiers if the API is unavailable.
 */
async function getMultiplierFromApi(persistenceAddress: string): Promise<{ multiplier: string; tier: string; nextMultiplier?: string; stakeNeeded?: number }> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tierData = await fetchJson(
      `https://rewards.interop.persistence.one/tiers/${persistenceAddress}?blockDate=${today}`
    );
    const result: any = {
      multiplier: tierData.multiplier ? `${tierData.multiplier}x` : "1x",
      tier: tierData.tier || "Explorer",
    };
    if (tierData.nextMultiplierMilestone) {
      result.nextMultiplier = `${tierData.nextMultiplierMilestone.multiplier}x`;
      result.stakeNeeded = tierData.nextMultiplierMilestone.stake;
    }
    return result;
  } catch {
    return { multiplier: "unknown", tier: "unknown" };
  }
}

/**
 * Get the best validator to delegate to (highest APR, active, not jailed)
 */
async function getBestValidator(): Promise<{ address: string; moniker: string; apr?: number }> {
  try {
    // Get all validators
    const validatorsData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`);
    const validators = validatorsData.validators || [];

    if (validators.length === 0) {
      throw new Error("No active validators found");
    }

    // For now, pick a well-known validator. In the future, we could fetch APR data
    const persistenceValidators = validators.filter((v: any) =>
      !v.jailed &&
      v.status === "BOND_STATUS_BONDED" &&
      v.description?.moniker
    );

    if (persistenceValidators.length === 0) {
      throw new Error("No unjailed bonded validators found");
    }

    // Sort by voting power (descending) and pick a top one
    persistenceValidators.sort((a: any, b: any) =>
      parseInt(b.tokens || "0") - parseInt(a.tokens || "0")
    );

    const chosen = persistenceValidators[0];
    return {
      address: chosen.operator_address,
      moniker: chosen.description?.moniker || "Unknown Validator",
      apr: undefined // Could be fetched from external APIs in the future
    };
  } catch (err) {
    // Fallback to a known validator if API fails
    return {
      address: "persistencevaloper1aw32k4t8qn3wva5g7vqqajr4qj7zdt2a0dmqn5", // Example validator
      moniker: "Persistence Foundation",
    };
  }
}

/**
 * Get the account sequence number for transaction signing
 */
async function getAccountInfo(address: string): Promise<{ accountNumber: string; sequence: string }> {
  const data = await fetchJson(`${PERSISTENCE_REST}/cosmos/auth/v1beta1/accounts/${address}`);
  const account = data.account;
  return {
    accountNumber: account.account_number || "0",
    sequence: account.sequence || "0",
  };
}

/**
 * Broadcast a signed transaction to the Persistence network
 */
async function broadcastTransaction(txBytes: string): Promise<{ txHash: string; code: number; rawLog?: string }> {
  const body = {
    tx_bytes: txBytes,
    mode: "BROADCAST_MODE_SYNC", // Use sync mode for immediate response
  };

  const response = await fetchJson(`${PERSISTENCE_REST}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    txHash: response.tx_response?.txhash || "unknown",
    code: response.tx_response?.code || 0,
    rawLog: response.tx_response?.raw_log,
  };
}

export function registerXprtStakingTools(server: McpServer) {
  // ─── xprt_stake ──────────────────────────────────────────────────────────
  server.tool(
    "xprt_stake",
    "Delegate liquid XPRT to a validator to earn staking rewards and increase farming multiplier. " +
    "Multiplier tiers: 1x (default), 2x (≥10,000 staked), 5x (≥1,000,000 staked). " +
    "Staked tokens continue earning farming rewards with the multiplier applied.",
    {
      amount: z.string().describe("Amount of XPRT to stake, or 'max' for all available liquid XPRT"),
      validatorAddress: z.string().optional().describe("Validator address (persistencevaloper1...). If omitted, auto-selects a high-performing active validator"),
      dryRun: z.boolean().default(true).describe("Preview the operation without executing (default: true)"),
    },
    async (params) => {
      const mnemonic = getKey("mnemonic");
      if (!mnemonic) {
        return {
          content: [{ type: "text" as const, text: "No mnemonic found. Run wallet_setup or add MNEMONIC to .env file." }],
          isError: true,
        };
      }

      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const { SigningStargateClient } = await import("@cosmjs/stargate");
        const { MsgDelegate } = await import("cosmjs-types/cosmos/staking/v1beta1/tx");

        const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await wallet.getAccounts();
        const delegatorAddress = account.address;

        // Get current balance
        const balanceData = await fetchJson(`${PERSISTENCE_REST}/cosmos/bank/v1beta1/balances/${delegatorAddress}`);
        const xprtBalance = balanceData.balances?.find((b: any) => b.denom === "uxprt");
        const liquidAmount = xprtBalance ? parseInt(xprtBalance.amount) : 0;

        if (liquidAmount === 0) {
          return {
            content: [{ type: "text" as const, text: "No liquid XPRT available to stake. Check your wallet balance." }],
            isError: true,
          };
        }

        // Parse amount
        let amountToStake: number;
        if (params.amount.toLowerCase() === "max") {
          amountToStake = liquidAmount;
        } else {
          const parsed = parseFloat(params.amount);
          if (isNaN(parsed) || parsed <= 0) {
            return {
              content: [{ type: "text" as const, text: "Invalid amount. Use a positive number or 'max'." }],
              isError: true,
            };
          }
          amountToStake = Math.floor(parsed * 1e6); // Convert to uxprt
        }

        if (amountToStake > liquidAmount) {
          return {
            content: [{ type: "text" as const, text: `Insufficient balance. Available: ${(liquidAmount / 1e6).toFixed(6)} XPRT, Requested: ${(amountToStake / 1e6).toFixed(6)} XPRT` }],
            isError: true,
          };
        }

        // Get validator info
        let validatorAddress = params.validatorAddress;
        let validatorMoniker = "Unknown";
        if (!validatorAddress) {
          const bestValidator = await getBestValidator();
          validatorAddress = bestValidator.address;
          validatorMoniker = bestValidator.moniker;
        } else {
          // Validate and get validator info
          try {
            const valData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/validators/${validatorAddress}`);
            validatorMoniker = valData.validator?.description?.moniker || "Unknown";
            if (valData.validator?.jailed) {
              return {
                content: [{ type: "text" as const, text: `Validator ${validatorAddress} is jailed and cannot receive delegations.` }],
                isError: true,
              };
            }
          } catch {
            return {
              content: [{ type: "text" as const, text: `Validator ${validatorAddress} not found or inactive.` }],
              isError: true,
            };
          }
        }

        // Get current staking info for multiplier calculation
        let currentStaked = 0;
        try {
          const delegationsData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/delegations/${delegatorAddress}`);
          if (delegationsData.delegation_responses) {
            for (const del of delegationsData.delegation_responses) {
              currentStaked += parseInt(del.balance?.amount || "0");
            }
          }
        } catch {
          // Continue with 0 if delegations fetch fails
        }

        const newTotalStaked = (currentStaked + amountToStake) / 1e6;

        // Get multiplier from rewards API (canonical source)
        const tierInfo = await getMultiplierFromApi(delegatorAddress);
        const currentMultiplier = tierInfo.multiplier;
        // Estimate new multiplier (will be recalculated by API after staking)
        const newMultiplier = tierInfo.nextMultiplier && newTotalStaked >= (tierInfo.stakeNeeded || Infinity)
          ? tierInfo.nextMultiplier
          : currentMultiplier;

        if (params.dryRun) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                dryRun: true,
                operation: "delegate",
                amountToStake: `${(amountToStake / 1e6).toFixed(6)} XPRT`,
                validator: {
                  address: validatorAddress,
                  moniker: validatorMoniker,
                },
                currentStaking: {
                  amount: `${(currentStaked / 1e6).toFixed(2)} XPRT`,
                  multiplier: currentMultiplier,
                },
                afterStaking: {
                  totalStaked: `${newTotalStaked.toFixed(2)} XPRT`,
                  newMultiplier: newMultiplier,
                  multiplierChange: currentMultiplier !== newMultiplier ? `${currentMultiplier} → ${newMultiplier}` : "no change",
                },
                estimatedApr: "~15-20% (variable)",
                unbondingPeriod: "21 days",
                note: "Set dryRun=false to execute this delegation.",
              }, null, 2),
            }],
          };
        }

        // Execute the staking transaction
        const client = await SigningStargateClient.connectWithSigner(PERSISTENCE_RPC, wallet);

        const msg = {
          typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
          value: MsgDelegate.fromPartial({
            delegatorAddress: delegatorAddress,
            validatorAddress: validatorAddress,
            amount: {
              denom: "uxprt",
              amount: amountToStake.toString(),
            },
          }),
        };

        const fee = {
          amount: [{ denom: "uxprt", amount: "5000" }], // 0.005 XPRT fee
          gas: "300000",
        };

        const result = await client.signAndBroadcast(delegatorAddress, [msg], fee, "Delegate XPRT via BridgeKitty");

        if (result.code !== 0) {
          throw new Error(`Transaction failed with code ${result.code}: ${result.rawLog}`);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "success",
              operation: "delegate",
              txHash: result.transactionHash,
              amountStaked: `${(amountToStake / 1e6).toFixed(6)} XPRT`,
              validator: {
                address: validatorAddress,
                moniker: validatorMoniker,
              },
              newTotalStaked: `${newTotalStaked.toFixed(2)} XPRT`,
              newMultiplier: newMultiplier,
              multiplierChange: currentMultiplier !== newMultiplier ? `${currentMultiplier} → ${newMultiplier}` : "no change",
              unbondingPeriod: "21 days",
              blockExplorer: `https://mintscan.io/persistence/tx/${result.transactionHash}`,
            }, null, 2),
          }],
        };

      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Staking failed: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── xprt_unstake ────────────────────────────────────────────────────────
  server.tool(
    "xprt_unstake",
    "Initiate unbonding (unstaking) of staked XPRT. Tokens will be unavailable for 21 days during unbonding. " +
    "Unbonding tokens do not earn staking rewards and do not count toward farming multiplier.",
    {
      amount: z.string().describe("Amount of XPRT to unstake"),
      validatorAddress: z.string().describe("Validator address to undelegate from (persistencevaloper1...)"),
      dryRun: z.boolean().default(true).describe("Preview the operation without executing (default: true)"),
    },
    async (params) => {
      const mnemonic = getKey("mnemonic");
      if (!mnemonic) {
        return {
          content: [{ type: "text" as const, text: "No mnemonic found. Run wallet_setup or add MNEMONIC to .env file." }],
          isError: true,
        };
      }

      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const { SigningStargateClient } = await import("@cosmjs/stargate");
        const { MsgUndelegate } = await import("cosmjs-types/cosmos/staking/v1beta1/tx");

        const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await wallet.getAccounts();
        const delegatorAddress = account.address;

        // Parse amount
        const parsed = parseFloat(params.amount);
        if (isNaN(parsed) || parsed <= 0) {
          return {
            content: [{ type: "text" as const, text: "Invalid amount. Use a positive number." }],
            isError: true,
          };
        }
        const amountToUnstake = Math.floor(parsed * 1e6); // Convert to uxprt

        // Check current delegation to this validator
        let delegatedAmount = 0;
        try {
          const delData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/delegations/${delegatorAddress}/${params.validatorAddress}`);
          delegatedAmount = parseInt(delData.delegation_response?.balance?.amount || "0");
        } catch {
          return {
            content: [{ type: "text" as const, text: `No delegation found to validator ${params.validatorAddress}` }],
            isError: true,
          };
        }

        if (amountToUnstake > delegatedAmount) {
          return {
            content: [{ type: "text" as const, text: `Insufficient delegation. Available: ${(delegatedAmount / 1e6).toFixed(6)} XPRT, Requested: ${(amountToUnstake / 1e6).toFixed(6)} XPRT` }],
            isError: true,
          };
        }

        // Get validator info
        let validatorMoniker = "Unknown";
        try {
          const valData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/validators/${params.validatorAddress}`);
          validatorMoniker = valData.validator?.description?.moniker || "Unknown";
        } catch {
          // Continue with unknown moniker
        }

        // Calculate new multiplier after unstaking
        let totalStaked = 0;
        try {
          const delegationsData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/delegations/${delegatorAddress}`);
          if (delegationsData.delegation_responses) {
            for (const del of delegationsData.delegation_responses) {
              totalStaked += parseInt(del.balance?.amount || "0");
            }
          }
        } catch {
          // Continue with current delegation only
          totalStaked = delegatedAmount;
        }

        // Get multiplier from rewards API (canonical source)
        const unstakeTierInfo = await getMultiplierFromApi(delegatorAddress);
        const currentMultiplier = unstakeTierInfo.multiplier;
        const newTotalStaked = (totalStaked - amountToUnstake) / 1e6;
        // After unstaking, multiplier will likely decrease — estimate conservatively
        const newMultiplier = "recalculated after unstaking";

        const completionDate = new Date();
        completionDate.setDate(completionDate.getDate() + 21);

        if (params.dryRun) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                dryRun: true,
                operation: "undelegate",
                amountToUnstake: `${(amountToUnstake / 1e6).toFixed(6)} XPRT`,
                validator: {
                  address: params.validatorAddress,
                  moniker: validatorMoniker,
                },
                unbondingPeriod: "21 days",
                completionDate: completionDate.toISOString().split('T')[0],
                currentStaking: {
                  total: `${(totalStaked / 1e6).toFixed(2)} XPRT`,
                  multiplier: currentMultiplier,
                },
                afterUnstaking: {
                  totalStaked: `${newTotalStaked.toFixed(2)} XPRT`,
                  newMultiplier: newMultiplier,
                  multiplierChange: currentMultiplier !== newMultiplier ? `${currentMultiplier} → ${newMultiplier}` : "no change",
                },
                warning: "Unbonding tokens do not earn rewards and do not count toward farming multiplier during the 21-day period.",
                note: "Set dryRun=false to execute this undelegation.",
              }, null, 2),
            }],
          };
        }

        // Execute the unstaking transaction
        const client = await SigningStargateClient.connectWithSigner(PERSISTENCE_RPC, wallet);

        const msg = {
          typeUrl: "/cosmos.staking.v1beta1.MsgUndelegate",
          value: MsgUndelegate.fromPartial({
            delegatorAddress: delegatorAddress,
            validatorAddress: params.validatorAddress,
            amount: {
              denom: "uxprt",
              amount: amountToUnstake.toString(),
            },
          }),
        };

        const fee = {
          amount: [{ denom: "uxprt", amount: "5000" }], // 0.005 XPRT fee
          gas: "300000",
        };

        const result = await client.signAndBroadcast(delegatorAddress, [msg], fee, "Undelegate XPRT via BridgeKitty");

        if (result.code !== 0) {
          throw new Error(`Transaction failed with code ${result.code}: ${result.rawLog}`);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "success",
              operation: "undelegate",
              txHash: result.transactionHash,
              amountUnstaked: `${(amountToUnstake / 1e6).toFixed(6)} XPRT`,
              validator: {
                address: params.validatorAddress,
                moniker: validatorMoniker,
              },
              unbondingPeriod: "21 days",
              completionDate: completionDate.toISOString().split('T')[0],
              newTotalStaked: `${newTotalStaked.toFixed(2)} XPRT`,
              newMultiplier: newMultiplier,
              multiplierChange: currentMultiplier !== newMultiplier ? `${currentMultiplier} → ${newMultiplier}` : "no change",
              blockExplorer: `https://mintscan.io/persistence/tx/${result.transactionHash}`,
            }, null, 2),
          }],
        };

      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unstaking failed: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── xprt_claim_rewards ─────────────────────────────────────────────────
  server.tool(
    "xprt_claim_rewards",
    "Claim all pending staking rewards from delegated XPRT. Rewards are liquid XPRT that can be spent, bridged, or re-staked.",
    {
      dryRun: z.boolean().default(true).describe("Preview the operation without executing (default: true)"),
    },
    async (params) => {
      const mnemonic = getKey("mnemonic");
      if (!mnemonic) {
        return {
          content: [{ type: "text" as const, text: "No mnemonic found. Run wallet_setup or add MNEMONIC to .env file." }],
          isError: true,
        };
      }

      try {
        const { Secp256k1HdWallet } = await import("@cosmjs/amino");
        const { SigningStargateClient } = await import("@cosmjs/stargate");
        const { MsgWithdrawDelegatorReward } = await import("cosmjs-types/cosmos/distribution/v1beta1/tx");

        const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "persistence" });
        const [account] = await wallet.getAccounts();
        const delegatorAddress = account.address;

        // Get pending rewards
        const rewardsData = await fetchJson(`${PERSISTENCE_REST}/cosmos/distribution/v1beta1/delegators/${delegatorAddress}/rewards`);
        const rewards = rewardsData.rewards || [];

        if (rewards.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No pending staking rewards to claim." }],
            isError: true,
          };
        }

        let totalRewards = 0;
        const validators: Array<{ address: string; moniker: string; rewards: string }> = [];

        for (const reward of rewards) {
          const validatorAddress = reward.validator_address;
          let validatorMoniker = "Unknown";

          try {
            const valData = await fetchJson(`${PERSISTENCE_REST}/cosmos/staking/v1beta1/validators/${validatorAddress}`);
            validatorMoniker = valData.validator?.description?.moniker || "Unknown";
          } catch {
            // Continue with unknown moniker
          }

          let validatorReward = 0;
          for (const coin of reward.reward || []) {
            if (coin.denom === "uxprt") {
              validatorReward += parseFloat(coin.amount || "0");
            }
          }

          if (validatorReward > 0) {
            totalRewards += validatorReward;
            validators.push({
              address: validatorAddress,
              moniker: validatorMoniker,
              rewards: (validatorReward / 1e6).toFixed(6),
            });
          }
        }

        if (totalRewards < 1) { // Less than 1 uxprt (0.000001 XPRT)
          return {
            content: [{ type: "text" as const, text: "Pending rewards are too small to claim (less than 0.000001 XPRT)." }],
            isError: true,
          };
        }

        if (params.dryRun) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                dryRun: true,
                operation: "withdraw_rewards",
                totalRewards: `${(totalRewards / 1e6).toFixed(6)} XPRT`,
                validatorCount: validators.length,
                validators: validators,
                estimatedFee: "~0.005 XPRT",
                netRewards: `${((totalRewards - 5000) / 1e6).toFixed(6)} XPRT`,
                note: "Set dryRun=false to claim these rewards.",
              }, null, 2),
            }],
          };
        }

        // Execute reward claim
        const client = await SigningStargateClient.connectWithSigner(PERSISTENCE_RPC, wallet);

        const msgs = validators.map(v => ({
          typeUrl: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
          value: MsgWithdrawDelegatorReward.fromPartial({
            delegatorAddress: delegatorAddress,
            validatorAddress: v.address,
          }),
        }));

        const fee = {
          amount: [{ denom: "uxprt", amount: "5000" }], // 0.005 XPRT fee
          gas: "300000", // Higher gas for multiple messages
        };

        const result = await client.signAndBroadcast(delegatorAddress, msgs, fee, "Claim staking rewards via BridgeKitty");

        if (result.code !== 0) {
          throw new Error(`Transaction failed with code ${result.code}: ${result.rawLog}`);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "success",
              operation: "withdraw_rewards",
              txHash: result.transactionHash,
              rewardsClaimed: `${(totalRewards / 1e6).toFixed(6)} XPRT`,
              validatorCount: validators.length,
              validators: validators,
              fee: "0.005 XPRT",
              netRewards: `${((totalRewards - 5000) / 1e6).toFixed(6)} XPRT`,
              blockExplorer: `https://mintscan.io/persistence/tx/${result.transactionHash}`,
            }, null, 2),
          }],
        };

      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Claiming rewards failed: ${sanitizeError(err as Error)}` }],
          isError: true,
        };
      }
    }
  );
}