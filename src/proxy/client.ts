/**
 * Thin HTTP client for the BridgeKitty hosted backend.
 * Used by ProxyRoutingEngine to call the backend API.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Backend ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class BackendClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async quote(body: unknown): Promise<unknown> {
    return fetchJson(`${this.baseUrl}/api/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async execute(body: unknown): Promise<unknown> {
    return fetchJson(`${this.baseUrl}/api/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async status(trackingId: string, meta?: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams(meta);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return fetchJson(`${this.baseUrl}/api/v1/status/${encodeURIComponent(trackingId)}${qs}`);
  }

  async chains(): Promise<unknown> {
    return fetchJson(`${this.baseUrl}/api/v1/chains`);
  }

  async tokens(chainId: number): Promise<unknown> {
    return fetchJson(`${this.baseUrl}/api/v1/tokens?chainId=${chainId}`);
  }

  async health(): Promise<unknown> {
    return fetchJson(`${this.baseUrl}/api/v1/health`);
  }
}
