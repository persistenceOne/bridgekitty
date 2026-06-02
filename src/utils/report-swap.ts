/**
 * Best-effort swap reporting to the hosted backend for analytics attribution.
 *
 * The npm package is the `npm` source channel. When a swap is signed and
 * broadcast locally (bridge_execute sign_and_send), we know the txHash and can
 * report the completed swap so it appears on the volume/chain-flow dashboards
 * tagged source=npm — the same data plane the web frontend writes via /swaps.
 *
 * Fire-and-forget: never throws, never blocks the tool result. If the backend
 * URL is unset or the POST fails, the swap simply isn't attributed (telemetry
 * still captured the execute event server-side).
 */

const DEFAULT_BACKEND_URL = "https://api.bridgekitty.persistence.one";
const REPORT_TIMEOUT_MS = 8_000;

export interface SwapReport {
  userAddress: string;
  txHash: string;
  quoteId: string;
  provider?: string;
  fromChain: string;
  toChain: string;
  fromTokenSymbol: string;
  toTokenSymbol: string;
  amount: string;
  volumeUsd?: number;
  status?: string;
}

/** POST a completed swap to the backend, tagged source=npm. Best-effort. */
export function reportSwap(report: SwapReport): void {
  const baseUrl = (process.env.BRIDGEKITTY_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

  void fetch(`${baseUrl}/api/v1/swaps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bk-source": "npm" },
    body: JSON.stringify({ status: "submitted", ...report }),
    signal: controller.signal,
  })
    .catch((err) => {
      console.error(`[reportSwap] failed (non-fatal): ${(err as Error).message}`);
    })
    .finally(() => clearTimeout(timer));
}
