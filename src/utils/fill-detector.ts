/**
 * Multi-signal fill detector for cross-chain bridge fills.
 *
 * Public RPCs aggressively cache ALL RPC responses (eth_call, eth_getLogs)
 * for 30-120s server-side. WebSocket transport does NOT bypass this.
 *
 * This module provides five detection methods:
 *
 * 1. **eth_subscribe("logs")** — push-based real-time subscription via raw
 *    WebSocket. The server pushes matching logs as new blocks are mined.
 *    NOT cached because each block is novel. Detects in 3-15s.
 *    Uses BROAD filter (token + Transfer topic only) with client-side
 *    recipient filtering, because some RPCs don't support topic[2] filtering
 *    in subscriptions. ONLY uses drpc (publicnode silently drops log events).
 *
 * 2. **newHeads + targeted getLogs** — subscribe to new block headers via WS,
 *    then do a getLogs for just that block number. Bypasses RPC caching
 *    because we query a specific (newly mined) block.
 *
 * 3. HTTP getLogs — rotated across RPCs, 30-120s (server-side cached)
 * 4. HTTP balance check — rotated across RPCs, 30-120s (server-side cached)
 * 5. Status API — Persistence backend (often broken)
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

/**
 * Chain ID → WebSocket RPC URLs for eth_subscribe("logs")
 *
 * NOTE: publicnode accepts eth_subscribe("logs") but SILENTLY DROPS events —
 * it never pushes log notifications despite returning a valid subscription ID.
 * Only drpc reliably delivers log push events.
 */
const WS_RPCS_LOGS: Record<number, string[]> = {
  1: ["wss://eth.drpc.org"],
  56: ["wss://bsc.drpc.org"],
  8453: ["wss://base.drpc.org"],
  42161: ["wss://arbitrum.drpc.org"],
  10: ["wss://optimism.drpc.org"],
  137: ["wss://polygon.drpc.org"],
};

/** WS endpoints for newHeads (both publicnode and drpc work) */
const WS_RPCS_HEADS: Record<number, string[]> = {
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
  /** How many WS connections are alive? */
  connectedCount: () => number;
  /** Clean up all WebSocket connections. Must be called when done. */
  cleanup: () => void;
}

/**
 * Create a push-based fill watcher using raw WebSocket eth_subscribe.
 *
 * Two strategies run in parallel:
 * A) eth_subscribe("logs") on drpc — direct Transfer event push (fastest)
 * B) eth_subscribe("newHeads") — on each new block, do a targeted
 *    getLogs(blockNum, blockNum) which bypasses RPC caching
 *
 * Call BEFORE signAndExecute to give connections time to establish (~2-5s).
 * Check isDetected() in the polling loop — returns true as soon as a
 * matching Transfer event is found by ANY method.
 */
export function createFillWatcher(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  onDetected?: () => void,
): FillWatcher {
  let detected = false;
  const sockets: WebSocket[] = [];
  let connected = 0;
  const paddedWallet = ethers.zeroPadValue(walletAddress, 32).toLowerCase();

  const markDetected = () => {
    if (detected) return;
    detected = true;
    if (onDetected) onDetected();
  };

  // ─── Strategy A: Direct log subscription (drpc only) ───────────
  const logUrls = WS_RPCS_LOGS[chainId] ?? [];
  for (const url of logUrls) {
    try {
      const ws = new WebSocket(url);
      sockets.push(ws);

      ws.on("open", () => {
        connected++;
        console.error(`[fill-watcher] logs subscription connected: ${url}`);
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscribe",
          params: ["logs", { address: tokenAddress, topics: [TRANSFER_TOPIC] }],
          id: 1,
        }));
      });

      ws.on("message", (data: WebSocket.Data) => {
        if (detected) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === "eth_subscription" && msg.params?.result?.topics) {
            const topics: string[] = msg.params.result.topics;
            if (topics[2]?.toLowerCase() === paddedWallet) {
              markDetected();
            }
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => { connected = Math.max(0, connected - 1); });
      ws.on("error", () => { /* will trigger close */ });
    } catch { /* ignore */ }
  }

  // ─── Strategy B: newHeads + targeted getLogs ────────────────────
  // On each new block, query that specific block for Transfer events to
  // our wallet. Bypasses RPC caching because the block number is new.
  const headUrls = WS_RPCS_HEADS[chainId] ?? [];
  const headUrl = headUrls[0]; // one subscription is enough
  if (headUrl) {
    try {
      const ws = new WebSocket(headUrl);
      sockets.push(ws);
      let subscribed = false;

      ws.on("open", () => {
        connected++;
        console.error(`[fill-watcher] newHeads subscription connected: ${headUrl}`);
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscribe",
          params: ["newHeads"],
          id: 2,
        }));
      });

      ws.on("message", (data: WebSocket.Data) => {
        if (detected) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 2 && msg.result) { subscribed = true; return; }
          if (subscribed && msg.method === "eth_subscription" && msg.params?.result?.number) {
            const blockNum = parseInt(msg.params.result.number, 16);
            // Fire-and-forget: check this specific block for our Transfer
            checkSingleBlockForTransfer(chainId, tokenAddress, paddedWallet, blockNum)
              .then(found => { if (found) markDetected(); })
              .catch(() => { /* non-fatal */ });
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => { connected = Math.max(0, connected - 1); });
      ws.on("error", () => { /* will trigger close */ });
    } catch { /* ignore */ }
  }

  const cleanup = () => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
  };

  const watcher: FillWatcher = {
    isDetected: () => detected,
    connectedCount: () => connected,
    cleanup: () => {
      cleanup();
      _activeWatchers.delete(watcher);
    },
  };
  _activeWatchers.add(watcher);
  return watcher;
}

// Track active watchers for process-exit cleanup
const _activeWatchers = new Set<FillWatcher>();
process.on("exit", () => { for (const w of _activeWatchers) { try { w.cleanup(); } catch {} } });

/**
 * Check a single specific block for Transfer events to our wallet.
 * Uses a fresh HTTP provider — since the block is brand new, this
 * bypasses server-side RPC caching.
 */
async function checkSingleBlockForTransfer(
  chainId: number,
  tokenAddress: string,
  paddedWallet: string,
  blockNumber: number,
): Promise<boolean> {
  const provider = getFreshProvider(chainId, blockNumber % 10);
  if (!provider) return false;

  try {
    const logs = await Promise.race([
      provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC, null, paddedWallet],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      }),
      rejectAfter(3_000, "single-block getLogs timeout"),
    ]);
    return logs.length > 0;
  } catch {
    return false;
  } finally {
    provider.destroy();
  }
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
