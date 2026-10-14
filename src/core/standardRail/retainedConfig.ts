import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Previous provider wallet keys, by address, that orders admitted under an
 * older listing version still need: the gateway verifies every answer about
 * an order with the keys its checkout snapshot named. Comma-separated
 * non-zero 32-byte keys in `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS`; the
 * current key is not repeated there. Secret, like the current key: never in
 * manifests, bundles, logs or support material.
 */
export function parseRetainedSigningKeys(
  env: NodeJS.ProcessEnv,
  currentKey: Hex,
): ReadonlyMap<Address, Hex> {
  const keys = new Map<Address, Hex>();
  const current = privateKeyToAccount(currentKey).address;
  for (const raw of (env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) {
      throw new Error("PROVIDER_RETAINED_WALLET_PRIVATE_KEYS must list non-zero 32-byte private keys");
    }
    const address = privateKeyToAccount(value as Hex).address;
    if (address === current || keys.has(address)) {
      throw new Error("PROVIDER_RETAINED_WALLET_PRIVATE_KEYS must list distinct previous keys only");
    }
    keys.set(address, value as Hex);
  }
  return keys;
}

/**
 * The provider audiences servicing calls (dispatch, status, lifecycle) may be
 * addressed to: the current one and any previous one in
 * `STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES`, so orders whose checkout
 * snapshot names an older public origin keep being serviced after a move.
 * New quotes and intake always use the current audience.
 */
export function parseServicingAudiences(
  env: NodeJS.ProcessEnv,
  current: string,
): ReadonlySet<string> {
  const audiences = new Set([current]);
  for (const raw of (env.STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES must list credential-free URLs");
    }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES must list credential-free URLs");
    }
    if (audiences.has(value)) {
      throw new Error("STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES must list distinct previous audiences");
    }
    audiences.add(value);
  }
  return audiences;
}

/** A recorded agent wallet, checksummed; null when the bundle field is unusable. */
export function walletAddress(value: unknown): Address | null {
  try {
    return typeof value === "string" ? getAddress(value) : null;
  } catch {
    return null;
  }
}
