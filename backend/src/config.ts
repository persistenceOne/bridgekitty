/**
 * Backend configuration loaded from environment variables.
 */
export const config = {
  port: Number(process.env.PORT) || 3000,

  // Fee configuration
  feeRecipientAddress: process.env.FEE_RECIPIENT_ADDRESS || "0xb24aCFcda187135490d81517ab56709FdDe6a81A",

  // Per-provider fee settings
  lifi: {
    apiKey: process.env.LIFI_API_KEY,
    integrator: process.env.LIFI_INTEGRATOR_ID,
    feeBps: process.env.LIFI_FEE_BPS, // e.g. "30" = 0.30%
  },
  debridge: {
    affiliateFeePercent: process.env.DEBRIDGE_FEE_PERCENT, // e.g. "0.1"
  },
  relay: {
    feeBps: process.env.RELAY_FEE_BPS, // e.g. "30" = 0.30%
  },
  squid: {
    integratorId: process.env.SQUID_INTEGRATOR_ID,
  },

  // Rate limiting
  quoteLimitPerMinute: Number(process.env.QUOTE_RATE_LIMIT) || 30,
  executeLimitPerMinute: Number(process.env.EXECUTE_RATE_LIMIT) || 10,

  // Quote store TTL in milliseconds
  quoteStoreTtlMs: Number(process.env.QUOTE_TTL_MS) || 5 * 60 * 1000, // 5 minutes
};
