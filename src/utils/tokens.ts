// Common token addresses across chains
// Used for resolving symbols to addresses when the user provides a symbol

export interface TokenEntry {
  symbol: string;
  name: string;
  decimals: number;
  addresses: Record<number, string>; // chainId -> address
}

const NATIVE = "0x0000000000000000000000000000000000000000";

export const COMMON_TOKENS: TokenEntry[] = [
  {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    addresses: {
      1: NATIVE,
      10: NATIVE,
      42161: NATIVE,
      8453: NATIVE,
      59144: NATIVE,
      534352: NATIVE,
      324: NATIVE,
      81457: NATIVE,
      7777777: NATIVE,
      34443: NATIVE,
    },
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    addresses: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    },
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    addresses: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      56: "0x55d398326f99059fF775485246999027B3197955",
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
  },
  {
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
    addresses: {
      1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      10: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
      42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      137: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    },
  },
  {
    symbol: "BNB",
    name: "BNB",
    decimals: 18,
    addresses: {
      56: NATIVE,
    },
  },
];

export function resolveTokenAddress(
  symbol: string,
  chainId: number
): { address: string; decimals: number } | null {
  // If it looks like an address already, return it
  if (symbol.startsWith("0x") && symbol.length === 42) {
    return { address: symbol, decimals: 18 }; // default decimals, will be overridden by API
  }
  const upper = symbol.toUpperCase();
  const token = COMMON_TOKENS.find((t) => t.symbol === upper);
  if (!token) return null;
  const address = token.addresses[chainId];
  if (!address) return null;
  return { address, decimals: token.decimals };
}

export function formatTokenAmount(amountRaw: string, decimals: number): string {
  const str = amountRaw.padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  const trimmed = fracPart.replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

export function parseTokenAmount(amount: string, decimals: number): string {
  const [intPart, fracPart = ""] = amount.split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const raw = intPart + padded;
  return raw.replace(/^0+/, "") || "0";
}
