/**
 * Multi-signal fill detector for cross-chain bridge fills.
 *
 * Public RPCs aggressively cache ALL RPC responses (eth_call, eth_getLogs)
 * for 30-120s server-side. WebSocket transport does NOT bypass this.
 *
 * This module provides four detection methods:
 *
 * 1. **eth_subscribe("logs")** — push-based real-time subscription via raw
 *    WebSocket. The server pushes matching logs as new blocks are mined.
 *    NOT cached because each block is novel. Detects in 3-15s.
 *    Uses BROAD filter (token + Transfer topic only) with client-side
 *    recipient filtering, because some RPCs don't support topic[2] filtering
 *    in subscriptions.
 *
 * 2. HTTP getLogs — rotated across RPCs, 30-120s (server-side cached)
 * 3. HTTP balance check — rotated across RPCs, 30-120s (server-side cached)
 * 4. Status API — Persistence backend (often broken)
 *
 * IMPORTANT: Create the FillWatcher BEFORE the initiate transaction to
 * allow time for WebSocket connection + subscription establishment.
 */

import { ethers } from "ethers";
import WebSocket from "ws";
import { getFreshProvider } from "./gas-estimator.js";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

/** Timeout for each individual RPC call */
const RPC_CALL_TIMEOUT_MS = 6_000;

/** Chain ID → WebSocket RPC URLs */
const WS_RPCS: Record<number, string[]> = {
  1: ["wss://ethereum-rpc.publicnode.com", "wss://eth.drpc.org"],
  56: ["wss://bsc-rpc.publicnode.com", "wss://bsc.drpc.org"],
  8453: ["wss://base-rpc.publicnode.com", "wss://base.drpc.org"],
  42161: ["wss://arbitrum-one-rpc.publicnode.com", "wss://arbitrum.drpc.org"],
  10: ["wss://optimism-rpc.publicnode.com", "wss://optimism.drpc.org"],
  137: ["wss://polygon-bor-rpc.publicnode.com", "wss://polygon.drpc.org"],
};

// ─── Push-based fill watcher (eth_subscribe) ────────────────────────

export interface FillWatcher {
  /** Non-blocking check: has the fill been detected? */
  isDetected: () => boolean;
  /** Clean up all WebSocket connections. Must be called when done. */
  cleanup: () => void;
}

/**
 * Create a push-based fill watcher using raw WebSocket eth_subscribe.
 *
 * Connects to all available WS RPCs for the chain and subscribes to
 * Transfer events on the token contract with a BROAD filter (no topic[2]).
 * Client-side filters for transfers TO the wallet address.
 *
 * Call BEFORE signAndExecute to give connections time to establish (~2-5s).
 * Check isDetected() in the polling loop — returns true as soon as a
 * matching Transfer event is pushed by ANY connected RPC.
 */
export function createFillWatcher(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  onDetected?: () => void,
): FillWatcher {
  const wsUrls = WS_RPCS[chainId];
  if (!wsUrls?.length) {
    return { isDetected: () => false, cleanup: () => {} };
  }

  let detected = false;
  const sockets: WebSocket[] = [];
  const paddedWallet = ethers.zeroPadValue(walletAddress, 32).toLowerCase();

  for (const url of wsUrls) {
    try {
      const ws = new WebSocket(url);
      sockets.push(ws);

      ws.on("open", () => {
        // Subscribe to ALL Transfer events on this token (broad filter).
        // We filter for our wallet client-side because some RPCs don't
        // reliably support topic[2] filtering in eth_subscribe.
        const subscribeMsg = JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscribe",
          params: [
            "logs",
            {
              address: tokenAddress,
              topics: [TRANSFER_TOPIC],
            },
          ],
          id: 1,
        });
        ws.send(subscribeMsg);
      });

      ws.on("message", (data: WebSocket.Data) => {
        if (detected) return;
        try {
          const msg = JSON.parse(data.toString());
          // Subscription responses look like:
          // { jsonrpc: "2.0", method: "eth_subscription", params: { result: { topics: [...], ... } } }
          if (msg.method === "eth_subscription" && msg.params?.result?.topics) {
            const topics: string[] = msg.params.result.topics;
            // topics[2] = padded recipient address
            if (topics[2]?.toLowerCase() === paddedWallet) {
              detected = true;
              if (onDetected) onDetected();
            }
          }
        } catch { /* ignore malformed messages */ }
      });

      ws.on("error", () => { /* ignore connection errors — we have multiple URLs */ });
    } catch { /* ignore failed connections */ }
  }

  const cleanup = () => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
  };

  return { isDetected: () => detected, cleanup };
}

// ─── HTTP getLogs (fallback, server-side cached) ────────────────────

export interface TransferEventResult {
  found: boolean;
  latestBlock?: number;
}

export interface BalanceChangeResult {
  changed: boolean;
  newBalance: bigint;
}

/**
 * Check for fill via ERC20 Transfer event logs over HTTP.
 * Uses fresh providers rotated across RPCs. Subject to server-side
 * caching (30-120s), kept as a fallback for when WS subscription fails.
 */
export async function checkTransferEvents(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  fromBlock: number,
  rpcIndex: number,
): Promise<TransferEventResult> {
  const provider = getFreshProvider(chainId, rpcIndex);
  if (!provider) return { found: false };

  try {
    const paddedAddress = ethers.zeroPadValue(walletAddress, 32);

    const [logs, currentBlock] = await Promise.all([
      Promise.race([
        provider.getLogs({
          address: tokenAddress,
          topics: [TRANSFER_TOPIC, null, paddedAddress],
          fromBlock,
          toBlock: "latest",
        }),
        rejectAfter(RPC_CALL_TIMEOUT_MS, "getLogs timeout"),
      ]),
      Promise.race([
        provider.getBlockNumber(),
        rejectAfter(RPC_CALL_TIMEOUT_MS, "getBlockNumber timeout"),
      ]).catch(() => fromBlock),
    ]);

    return { found: logs.length > 0, latestBlock: currentBlock };
  } catch {
    return { found: false };
  } finally {
    provider.destroy();
  }
}

// ─── HTTP balance check (fallback, server-side cached) ──────────────

/**
 * Check for fill via balance change using a fresh (uncached) provider.
 * Each call cycles through a different RPC via rpcIndex.
 */
export async function checkBalanceChange(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  preBalance: bigint,
  rpcIndex: number,
): Promise<BalanceChangeResult> {
  const provider = getFreshProvider(chainId, rpcIndex);
  if (!provider) return { changed: false, newBalance: preBalance };

  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
    const bal: bigint = await Promise.race([
      contract.balanceOf(walletAddress),
      rejectAfter(RPC_CALL_TIMEOUT_MS, "balanceOf timeout"),
    ]);
    return { changed: bal > preBalance, newBalance: bal };
  } catch {
    return { changed: false, newBalance: preBalance };
  } finally {
    provider.destroy();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

/**
 * Get the current block number on a chain using a fresh provider.
 */
export async function getCurrentBlockNumber(chainId: number): Promise<number> {
  const provider = getFreshProvider(chainId, 0);
  if (!provider) throw new Error(`No RPC configured for chain ${chainId}`);

  try {
    return await Promise.race([
      provider.getBlockNumber(),
      rejectAfter(RPC_CALL_TIMEOUT_MS, "getBlockNumber timeout"),
    ]);
  } finally {
    provider.destroy();
  }
}

/** Helper: reject a promise after ms with the given message */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
