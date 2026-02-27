/**
 * ACP Job Handler for BridgeKitty
 *
 * Processes incoming ACP jobs:
 *   1. Parse & validate requirement params
 *   2. Call the routing engine for quotes
 *   3. Build unsigned transaction data
 *   4. Format and return the deliverable
 */

import type { RoutingEngine, CachedQuote } from "../routing/engine.js";
import type { TransactionRequest } from "../backends/types.js";
import { BackendValidationError } from "../backends/types.js";
import { resolveChainId, getChainName } from "../utils/chains.js";
import { resolveToken } from "../utils/token-registry.js";
import { parseTokenAmount } from "../utils/tokens.js";
import { simulateTransaction } from "../utils/tx-simulator.js";
import type { AcpBridgeRequirement, AcpDeliverable, AcpConfig } from "./types.js";

/** Timeout for buildTransaction API calls (ms). */
const BUILD_TX_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Validate and parse raw ACP job requirement into structured params.
 */
export function parseRequirement(raw: unknown): AcpBridgeRequirement {
  if (!raw || typeof raw !== "object") {
    throw new Error("Job requirement must be a JSON object");
  }

  const req = raw as Record<string, unknown>;

  const fromChain = String(req.fromChain ?? "");
  const toChain = String(req.toChain ?? "");
  const fromToken = String(req.fromToken ?? "");
  const toToken = String(req.toToken ?? "");
  const amount = String(req.amount ?? "");
  const senderAddress = String(req.senderAddress ?? "");
  const recipientAddress = req.recipientAddress ? String(req.recipientAddress) : undefined;

  if (!fromChain) throw new Error("Missing required field: fromChain");
  if (!toChain) throw new Error("Missing required field: toChain");
  if (!fromToken) throw new Error("Missing required field: fromToken");
  if (!toToken) throw new Error("Missing required field: toToken");
  if (!amount) throw new Error("Missing required field: amount");
  if (!senderAddress) throw new Error("Missing required field: senderAddress");

  return { fromChain, toChain, fromToken, toToken, amount, senderAddress, recipientAddress };
}

/**
 * Process an ACP bridge job and produce a deliverable.
 *
 * This is a pure function that takes the routing engine + params and returns
 * a deliverable. It does NOT interact with the ACP SDK directly, making it
 * easy to test.
 */
export async function handleBridgeJob(
  engine: RoutingEngine,
  requirement: AcpBridgeRequirement,
  timeoutMs: number = 30_000,
): Promise<AcpDeliverable> {
  const deadline = Date.now() + timeoutMs;

  try {
    // ─── Resolve chains ──────────────────────────────────────────────
    const fromChainId = resolveChainId(requirement.fromChain);
    const toChainId = resolveChainId(requirement.toChain);

    if (!fromChainId) {
      return {
        status: "error",
        error: `Unknown source chain: ${requirement.fromChain}`,
        instructions: "Use chain name (e.g. 'base') or chain ID (e.g. '8453').",
      };
    }
    if (!toChainId) {
      return {
        status: "error",
        error: `Unknown destination chain: ${requirement.toChain}`,
        instructions: "Use chain name (e.g. 'arbitrum') or chain ID (e.g. '42161').",
      };
    }

    // ─── Resolve tokens ──────────────────────────────────────────────
    const fromTokenResult = resolveToken(requirement.fromToken, fromChainId);
    if (!fromTokenResult.ok) {
      return {
        status: "error",
        error: `Token resolution failed for ${requirement.fromToken} on ${getChainName(fromChainId)}: ${fromTokenResult.error}`,
      };
    }

    const toTokenResult = resolveToken(requirement.toToken, toChainId);
    if (!toTokenResult.ok) {
      return {
        status: "error",
        error: `Token resolution failed for ${requirement.toToken} on ${getChainName(toChainId)}: ${toTokenResult.error}`,
      };
    }

    // ─── Parse amount ────────────────────────────────────────────────
    const amountTrimmed = requirement.amount.trim();
    if (!amountTrimmed || !/^\d+\.?\d*$/.test(amountTrimmed)) {
      return {
        status: "error",
        error: `Invalid amount: "${requirement.amount}". Must be a positive number.`,
      };
    }

    const amountRaw = parseTokenAmount(amountTrimmed, fromTokenResult.decimals);

    // ─── Get quotes ──────────────────────────────────────────────────
    let quotes: CachedQuote[];
    try {
      quotes = await engine.getQuotes({
        fromChainId,
        toChainId,
        fromTokenAddress: fromTokenResult.address,
        toTokenAddress: toTokenResult.address,
        amountRaw,
        fromAddress: requirement.senderAddress,
        toAddress: requirement.recipientAddress,
        preference: "cheapest", // ACP jobs optimize for value
        fromTokenDecimals: fromTokenResult.decimals,
        toTokenDecimals: toTokenResult.decimals,
      });
    } catch (err) {
      if (err instanceof BackendValidationError) {
        return { status: "error", error: err.message };
      }
      throw err;
    }

    if (quotes.length === 0) {
      const diagnosis = engine.getLastRequestDiagnosis();
      if (diagnosis.allErrored) {
        return {
          status: "error",
          error: "All bridge providers are currently unavailable. Try again later.",
        };
      }
      return {
        status: "no_routes",
        error: `No bridge routes found for ${requirement.amount} ${fromTokenResult.symbol} from ${getChainName(fromChainId)} to ${getChainName(toChainId)}.`,
        instructions: "This route may not be supported by any provider.",
      };
    }

    // ─── Pick best quote ─────────────────────────────────────────────
    const best = quotes[0];

    // ─── Check remaining time ────────────────────────────────────────
    if (Date.now() > deadline - 5_000) {
      // Less than 5s remaining — return quote without tx data
      return {
        status: "success",
        quote: {
          provider: best.provider,
          youReceiveMin: `${best.minOutputAmount} ${toTokenResult.symbol}`,
          estimatedGasFee: best.estimatedGasCostUsd !== null
            ? `$${best.estimatedGasCostUsd.toFixed(2)}`
            : "unknown",
          estimatedTime: formatTime(best.estimatedTimeSeconds),
          route: best.route,
          quoteId: best.quoteId,
        },
        instructions: "Quote provided but transaction could not be built in time. Get a fresh quote to build the transaction.",
        warnings: ["Transaction data not included due to time constraints."],
      };
    }

    // ─── Build transaction ───────────────────────────────────────────
    const backend = engine.getBackend(best.backendName);
    if (!backend) {
      return {
        status: "error",
        error: `Backend '${best.backendName}' not available.`,
      };
    }

    let txRequest: TransactionRequest;
    try {
      txRequest = await withTimeout(
        backend.buildTransaction(best),
        Math.min(BUILD_TX_TIMEOUT_MS, deadline - Date.now() - 2_000),
        `buildTransaction (${backend.name})`
      );
    } catch (err) {
      // Return quote even if tx build fails
      return {
        status: "success",
        quote: {
          provider: best.provider,
          youReceiveMin: `${best.minOutputAmount} ${toTokenResult.symbol}`,
          estimatedGasFee: best.estimatedGasCostUsd !== null
            ? `$${best.estimatedGasCostUsd.toFixed(2)}`
            : "unknown",
          estimatedTime: formatTime(best.estimatedTimeSeconds),
          route: best.route,
          quoteId: best.quoteId,
        },
        instructions: (() => {
          const errMsg = (err as Error).message;
          console.error(`[acp-handler] buildTransaction failed for ${backend.name}:`, errMsg);
          return "Quote found but transaction build failed. Try again for fresh transaction data.";
        })(),
        warnings: ["Transaction data not available."],
      };
    }

    // ─── Simulate transaction ────────────────────────────────────────
    const warnings: string[] = [];
    const simulation = await simulateTransaction(txRequest.chainId, {
      to: txRequest.to,
      data: txRequest.data,
      value: txRequest.value,
    });

    if (!simulation.success) {
      warnings.push(`Simulation warning: ${simulation.error}. Transaction may still succeed — verify before signing.`);
    }
    if (simulation.warning) {
      warnings.push(simulation.warning);
    }
    if (simulation.estimatedGas) {
      txRequest.gasLimit = txRequest.gasLimit ?? simulation.estimatedGas;
    }

    // ─── Build deliverable ───────────────────────────────────────────
    const deliverable: AcpDeliverable = {
      status: "success",
      quote: {
        provider: best.provider,
        youReceiveMin: `${best.minOutputAmount} ${toTokenResult.symbol}`,
        estimatedGasFee: best.estimatedGasCostUsd !== null
          ? `$${best.estimatedGasCostUsd.toFixed(2)}`
          : "unknown",
        estimatedTime: formatTime(best.estimatedTimeSeconds),
        route: best.route,
        quoteId: best.quoteId,
      },
      transaction: {
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value,
        chainId: txRequest.chainId,
        ...(txRequest.gasLimit ? { gasLimit: txRequest.gasLimit } : {}),
      },
    };

    if (txRequest.approvalTx) {
      deliverable.approvalTx = {
        to: txRequest.approvalTx.to,
        data: txRequest.approvalTx.data,
        value: txRequest.approvalTx.value,
        chainId: txRequest.approvalTx.chainId,
      };
      deliverable.instructions =
        "Two transactions needed: (1) Send the approvalTransaction first to approve token spending. " +
        "(2) Then send the main transaction to initiate the bridge. " +
        "The approval is for the exact bridge amount only.";
    } else {
      deliverable.instructions =
        "Sign and send the transaction to initiate the bridge transfer. " +
        `Expected to receive at least ${best.minOutputAmount} ${toTokenResult.symbol} ` +
        `on ${getChainName(toChainId)} in ~${formatTime(best.estimatedTimeSeconds)}.`;
    }

    if (warnings.length > 0) {
      deliverable.warnings = warnings;
    }

    return deliverable;
  } catch (err) {
    // Log full error server-side for debugging
    console.error(`[acp-handler] Internal error processing bridge job:`, err);
    // Return sanitized error to external callers — don't expose raw backend details
    return {
      status: "error",
      error: "Bridge quote failed. Please try again later.",
    };
  }
}
