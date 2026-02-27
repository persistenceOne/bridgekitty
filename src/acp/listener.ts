/**
 * ACP Listener for BridgeKitty
 *
 * Connects to the Virtuals ACP platform via the official Node SDK,
 * listens for incoming bridge jobs, processes them through the routing engine,
 * and submits deliverables back to ACP.
 *
 * Uses the `@virtuals-protocol/acp-node` SDK which handles:
 * - Socket.io connection to ACP backend
 * - EIP-712 typed data auth flow
 * - Smart contract interactions via Account Abstraction
 * - Job lifecycle management (accept → deliver)
 */

import acpModule from "@virtuals-protocol/acp-node";
import {
  AcpContractClientV2,
  AcpJobPhases,
  baseAcpConfigV2,
  baseSepoliaAcpConfigV2,
} from "@virtuals-protocol/acp-node";
import type { AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";

// Handle CJS/ESM interop — the default export may be wrapped
const AcpClient = (acpModule as any).default ?? acpModule;
import type { RoutingEngine } from "../routing/engine.js";
import type { AcpConfig, AcpDeliverable } from "./types.js";
import { parseRequirement, handleBridgeJob } from "./handler.js";

// ─── Concurrency Semaphore ───────────────────────────────────────────────────

class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

interface ListenerStats {
  jobsReceived: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsRejected: number;
  startedAt: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert AcpDeliverable to the SDK's DeliverablePayload type.
 * The SDK accepts `string | Record<string, unknown>`, so we serialize
 * our typed deliverable into a plain record.
 */
function toDeliverablePayload(deliverable: AcpDeliverable): Record<string, unknown> {
  return JSON.parse(JSON.stringify(deliverable)) as Record<string, unknown>;
}

// ─── Listener ────────────────────────────────────────────────────────────────

export class AcpListener {
  private semaphore: Semaphore;
  private stats: ListenerStats;
  private isShuttingDown = false;

  constructor(
    private config: AcpConfig,
    private engine: RoutingEngine,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrentJobs);
    this.stats = {
      jobsReceived: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsRejected: 0,
      startedAt: new Date(),
    };
  }

  /**
   * Start listening for ACP jobs. This connects to the ACP platform
   * via WebSocket and begins processing incoming jobs.
   */
  async start(): Promise<void> {
    console.log("🐱 BridgeKitty ACP Listener starting...");
    console.log(`   Service price: $${this.config.servicePriceUsd} per job`);
    console.log(`   Max concurrent jobs: ${this.config.maxConcurrentJobs}`);
    console.log(`   Job timeout: ${this.config.jobTimeoutMs}ms`);
    console.log(`   Network: ${this.config.useTestnet ? "Base Sepolia (testnet)" : "Base (mainnet)"}`);

    const chainConfig = this.config.useTestnet
      ? baseSepoliaAcpConfigV2
      : baseAcpConfigV2;

    // ⚠️ SECURITY (HIGH-002): This wallet holds private keys on a hot server.
    // Keep MINIMUM balance needed for gas fees only. Sweep accumulated service
    // fees to a cold wallet regularly (daily recommended). Monitor balance alerts.
    const contractClient = await AcpContractClientV2.build(
      this.config.agentWalletPrivateKey as `0x${string}`,
      this.config.agentEntityId,
      this.config.agentWalletAddress as `0x${string}`,
      chainConfig,
    );

    // eslint-disable-next-line no-new, @typescript-eslint/no-unsafe-call
    new (AcpClient as any)({
      acpContractClient: contractClient,
      onNewTask: (job: AcpJob, memoToSign?: AcpMemo) => {
        this.onNewTask(job, memoToSign).catch((err) => {
          console.error(`[ACP] Unhandled error in job handler:`, err);
        });
      },
    });

    console.log("🐱 BridgeKitty ACP Listener is LIVE");
    console.log(`   Agent wallet: ${this.config.agentWalletAddress}`);
    console.log(`   Integrator wallet: ${this.config.integratorWalletAddress}`);
    console.log("   Waiting for jobs...\n");
  }

  /**
   * Handle an incoming ACP job/task notification.
   */
  private async onNewTask(job: AcpJob, memoToSign?: AcpMemo): Promise<void> {
    // ─── Phase: REQUEST → NEGOTIATION (new job request) ──────────────
    if (
      job.phase === AcpJobPhases.REQUEST &&
      memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION
    ) {
      this.stats.jobsReceived++;
      console.log(`[ACP] Job #${job.id} received — accepting...`);

      try {
        // Validate the requirement before accepting
        const rawRequirement = job.requirement;
        parseRequirement(rawRequirement); // throws if invalid

        // (NEW-LOW-004) Verify job fee meets minimum service price
        const jobFee = (job as any).fee ?? (job as any).price ?? null;
        console.log(`[ACP] Job #${job.id} fee: ${jobFee !== null ? `$${jobFee}` : "unknown"}`);
        if (jobFee !== null && jobFee !== undefined) {
          const feeNum = typeof jobFee === "string" ? parseFloat(jobFee) : Number(jobFee);
          if (!isNaN(feeNum) && feeNum < this.config.servicePriceUsd) {
            console.warn(
              `[ACP] Job #${job.id} fee ($${feeNum}) is below minimum service price ($${this.config.servicePriceUsd}). Rejecting.`
            );
            this.stats.jobsRejected++;
            await job.reject(
              `Job fee ($${feeNum}) is below the minimum service price ($${this.config.servicePriceUsd}).`
            );
            return;
          }
        }

        await job.accept("BridgeKitty can fulfill this bridge request.");
        await job.createRequirement(
          `Job #${job.id} accepted. Processing cross-chain bridge quote. Please make payment to proceed.`
        );
        console.log(`[ACP] Job #${job.id} accepted, awaiting payment.`);
      } catch (err) {
        console.error(`[ACP] Job #${job.id} rejected (bad requirement):`, (err as Error).message);
        this.stats.jobsRejected++;
        try {
          await job.reject(`Invalid requirement: ${(err as Error).message}`);
        } catch (rejectErr) {
          console.error(`[ACP] Failed to reject job #${job.id}:`, rejectErr);
        }
      }
      return;
    }

    // ─── Phase: TRANSACTION → EVALUATION (payment received, deliver) ─
    if (
      job.phase === AcpJobPhases.TRANSACTION &&
      memoToSign?.nextPhase === AcpJobPhases.EVALUATION
    ) {
      console.log(`[ACP] Job #${job.id} paid — processing bridge request...`);

      // Acquire semaphore slot
      await this.semaphore.acquire();
      const startTime = Date.now();

      try {
        if (this.isShuttingDown) {
          console.log(`[ACP] Shutting down — rejecting job #${job.id}`);
          await job.reject("Service is shutting down. Please try again later.");
          this.stats.jobsRejected++;
          return;
        }

        // Parse the requirement
        const rawRequirement = job.requirement;
        const requirement = parseRequirement(rawRequirement);

        // Process the bridge job
        const deliverable = await this.processWithTimeout(requirement, this.config.jobTimeoutMs);
        const elapsed = Date.now() - startTime;

        // Submit deliverable (convert to SDK-compatible payload)
        await job.deliver(toDeliverablePayload(deliverable));

        if (deliverable.status === "success") {
          this.stats.jobsCompleted++;
          console.log(
            `[ACP] Job #${job.id} delivered ✅ (${elapsed}ms) — ` +
            `${deliverable.quote?.provider}: ${deliverable.quote?.youReceiveMin}`
          );
        } else {
          this.stats.jobsFailed++;
          console.log(
            `[ACP] Job #${job.id} delivered with status="${deliverable.status}" (${elapsed}ms) — ` +
            `${deliverable.error ?? "unknown"}`
          );
        }
      } catch (err) {
        this.stats.jobsFailed++;
        const elapsed = Date.now() - startTime;
        console.error(`[ACP] Job #${job.id} FAILED (${elapsed}ms):`, (err as Error).message);

        // Try to deliver an error response
        try {
          const errorDeliverable: AcpDeliverable = {
            status: "error",
            error: `Processing failed: ${(err as Error).message}`,
          };
          await job.deliver(toDeliverablePayload(errorDeliverable));
        } catch (deliverErr) {
          console.error(`[ACP] Failed to deliver error for job #${job.id}:`, deliverErr);
          // Last resort: try to reject
          try {
            await job.reject(`Service error: ${(err as Error).message}`);
          } catch {
            // Nothing more we can do
          }
        }
      } finally {
        this.semaphore.release();
      }
      return;
    }

    // ─── Other phases — log and ignore ───────────────────────────────
    console.log(`[ACP] Job #${job.id} phase=${job.phase} — no action needed`);
  }

  /**
   * Process a bridge job with timeout.
   */
  private async processWithTimeout(
    requirement: ReturnType<typeof parseRequirement>,
    timeoutMs: number,
  ): Promise<AcpDeliverable> {
    return Promise.race([
      handleBridgeJob(this.engine, requirement, timeoutMs),
      new Promise<AcpDeliverable>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Job processing timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Get current listener statistics.
   */
  getStats(): ListenerStats & { activeJobs: number; queuedJobs: number } {
    return {
      ...this.stats,
      activeJobs: this.semaphore.activeCount,
      queuedJobs: this.semaphore.waitingCount,
    };
  }

  /**
   * Gracefully shut down — stop accepting new jobs, wait for active ones.
   */
  async shutdown(): Promise<void> {
    console.log("\n🐱 BridgeKitty ACP Listener shutting down...");
    this.isShuttingDown = true;

    // Wait for active jobs to complete (up to 60s)
    const waitStart = Date.now();
    while (this.semaphore.activeCount > 0 && Date.now() - waitStart < 60_000) {
      console.log(`   Waiting for ${this.semaphore.activeCount} active job(s)...`);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const stats = this.getStats();
    console.log("\n📊 Session stats:");
    console.log(`   Jobs received:  ${stats.jobsReceived}`);
    console.log(`   Jobs completed: ${stats.jobsCompleted}`);
    console.log(`   Jobs failed:    ${stats.jobsFailed}`);
    console.log(`   Jobs rejected:  ${stats.jobsRejected}`);
    console.log("🐱 BridgeKitty ACP Listener stopped.\n");
  }
}
