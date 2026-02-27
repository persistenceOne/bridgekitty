/**
 * Circuit breaker for backend failure management.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Backend is failing, skip requests for a cooldown period
 * - HALF_OPEN: Testing with a single request after cooldown
 *
 * Transitions:
 * - CLOSED → OPEN: After `failureThreshold` failures within `failureWindowMs`
 * - OPEN → HALF_OPEN: After `cooldownMs` elapsed
 * - HALF_OPEN → CLOSED: On success
 * - HALF_OPEN → OPEN: On failure (with extended cooldown)
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit (default: 3) */
  failureThreshold?: number;
  /** Time window for counting failures in ms (default: 300_000 = 5 min) */
  failureWindowMs?: number;
  /** How long to wait before testing again in ms (default: 30_000 = 30s) */
  cooldownMs?: number;
  /** Extended cooldown after HALF_OPEN failure in ms (default: 60_000 = 60s) */
  extendedCooldownMs?: number;
}

interface BackendCircuit {
  state: CircuitState;
  failures: number[];  // timestamps of recent failures
  openedAt: number;    // when the circuit was opened
  cooldownMs: number;  // current cooldown duration
}

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 3,
  failureWindowMs: 300_000,
  cooldownMs: 30_000,
  extendedCooldownMs: 60_000,
};

export class CircuitBreaker {
  private circuits = new Map<string, BackendCircuit>();
  private halfOpenLocks = new Set<string>();
  private config: Required<CircuitBreakerConfig>;

  constructor(config?: CircuitBreakerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a backend is allowed to receive requests.
   * Returns true if the backend should be called, false if it should be skipped.
   */
  isAllowed(backendName: string): boolean {
    const circuit = this.circuits.get(backendName);
    if (!circuit) return true; // No circuit = never failed = allowed

    const now = Date.now();

    switch (circuit.state) {
      case "CLOSED":
        return true;

      case "OPEN": {
        // Check if cooldown has elapsed → transition to HALF_OPEN
        if (now - circuit.openedAt >= circuit.cooldownMs) {
          circuit.state = "HALF_OPEN";
          // Lock so only the first caller gets through (V3-LOW-001)
          if (this.halfOpenLocks.has(backendName)) return false;
          this.halfOpenLocks.add(backendName);
          return true; // Allow one test request
        }
        return false; // Still in cooldown
      }

      case "HALF_OPEN":
        // Only one concurrent request allowed in HALF_OPEN (V3-LOW-001)
        if (this.halfOpenLocks.has(backendName)) return false;
        this.halfOpenLocks.add(backendName);
        return true;

      default:
        return true;
    }
  }

  /**
   * Report a successful request for a backend.
   * Gradual recovery: removes the oldest failure instead of clearing all at once.
   * Full reset only happens from HALF_OPEN state (successful probe).
   */
  recordSuccess(backendName: string): void {
    const circuit = this.circuits.get(backendName);
    if (!circuit) return;

    if (circuit.state === "HALF_OPEN") {
      // Successful probe — fully reset
      this.halfOpenLocks.delete(backendName);
      console.error(`[circuit-breaker] ${backendName}: HALF_OPEN → CLOSED (probe succeeded)`);
      circuit.state = "CLOSED";
      circuit.failures = [];
      circuit.cooldownMs = this.config.cooldownMs;
    } else if (circuit.state === "CLOSED" && circuit.failures.length > 0) {
      // Gradual recovery: remove oldest failure on each success
      circuit.failures.shift();
    }
  }

  /**
   * Report a failed request for a backend.
   * May transition to OPEN if threshold is exceeded.
   */
  recordFailure(backendName: string): void {
    const now = Date.now();

    let circuit = this.circuits.get(backendName);
    if (!circuit) {
      circuit = {
        state: "CLOSED",
        failures: [],
        openedAt: 0,
        cooldownMs: this.config.cooldownMs,
      };
      this.circuits.set(backendName, circuit);
    }

    if (circuit.state === "HALF_OPEN") {
      // Test request failed → back to OPEN with extended cooldown
      this.halfOpenLocks.delete(backendName);
      circuit.state = "OPEN";
      circuit.openedAt = now;
      circuit.cooldownMs = this.config.extendedCooldownMs;
      console.error(
        `[circuit-breaker] ${backendName}: HALF_OPEN → OPEN (probe failed, extended cooldown ${this.config.extendedCooldownMs}ms)`
      );
      return;
    }

    // Add failure timestamp (prune old failures outside the window)
    circuit.failures = circuit.failures
      .filter((t) => now - t < this.config.failureWindowMs)
      .concat(now);

    // Check if threshold exceeded
    if (circuit.failures.length >= this.config.failureThreshold) {
      circuit.state = "OPEN";
      circuit.openedAt = now;
      circuit.cooldownMs = this.config.cooldownMs;
      console.error(
        `[circuit-breaker] ${backendName}: CLOSED → OPEN (${circuit.failures.length} failures in ${this.config.failureWindowMs}ms window, cooldown ${this.config.cooldownMs}ms)`
      );
    }
  }

  /**
   * Get the current state of a backend's circuit.
   */
  getState(backendName: string): CircuitState {
    const circuit = this.circuits.get(backendName);
    if (!circuit) return "CLOSED";

    // Check for OPEN → HALF_OPEN transition
    if (circuit.state === "OPEN") {
      if (Date.now() - circuit.openedAt >= circuit.cooldownMs) {
        circuit.state = "HALF_OPEN";
      }
    }

    return circuit.state;
  }

  /**
   * Get a summary of all circuit states (for debugging/monitoring).
   */
  getAll(): Record<string, CircuitState> {
    const result: Record<string, CircuitState> = {};
    for (const [name] of this.circuits) {
      result[name] = this.getState(name);
    }
    return result;
  }

  /**
   * Reset a specific backend's circuit (for testing/admin).
   */
  reset(backendName: string): void {
    this.circuits.delete(backendName);
    this.halfOpenLocks.delete(backendName);
  }

  /**
   * Reset all circuits.
   */
  resetAll(): void {
    this.circuits.clear();
    this.halfOpenLocks.clear();
  }
}
