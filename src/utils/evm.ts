/**
 * Shared EVM utilities used across multiple backends.
 */

import { getAddress } from "ethers";

/**
 * Build ERC20 approve(address spender, uint256 amount) calldata.
 */
export function buildApproveData(spender: string, amount: string): string {
  // ERC20 approve(address,uint256) selector = 0x095ea7b3
  const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0x095ea7b3${spenderPadded}${amountHex}`;
}

/**
 * Check if an address is the native token (zero address).
 */
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isNativeToken(address: string): boolean {
  return (
    address === NATIVE_ADDRESS ||
    address === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ||
    address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  );
}

/**
 * Validate an EVM hex address (0x + 40 hex chars).
 * Returns { valid, warning? } — accepts all valid hex addresses but warns
 * on mixed-case addresses that fail EIP-55 checksum validation (MEDIUM-002).
 */
export function isValidEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;

  // If all-lowercase or all-uppercase (after 0x), no checksum to validate
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;

  // Mixed-case: validate EIP-55 checksum using ethers
  try {
    const checksummed = getAddress(address.toLowerCase());
    if (checksummed !== address) {
      console.warn(
        `[evm] MEDIUM-002: Address ${address} has invalid mixed-case (expected EIP-55: ${checksummed}). Accepting but flagging.`,
      );
    }
  } catch {
    console.warn(
      `[evm] MEDIUM-002: Could not verify EIP-55 checksum for ${address}. Accepting anyway.`,
    );
  }

  return true;
}
