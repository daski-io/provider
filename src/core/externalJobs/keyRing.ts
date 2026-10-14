import type { Hex } from "viem";
import type { Config } from "../config.js";
import { parseFieldEncryptionKeys, type FieldEncryptionKeyRing } from "../security/fieldEncryption.js";

/**
 * The key ring for external-job state, from PROVIDER_DATA_ENCRYPTION_KEY,
 * _KEY_ID and _PREVIOUS_KEYS (docs/configuration.md). No encryption key may
 * equal a signing key this provider holds, current or retained. An empty
 * ring is valid: synchronous-only installations need no key.
 */
export function externalJobKeyRing(
  env: Pick<Config, "PROVIDER_DATA_ENCRYPTION_KEY" | "PROVIDER_DATA_ENCRYPTION_KEY_ID"
    | "PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS" | "PROVIDER_WALLET_PRIVATE_KEY">,
  retainedSigningKeys: Iterable<Hex> = [],
): FieldEncryptionKeyRing {
  return parseFieldEncryptionKeys({
    activeKey: env.PROVIDER_DATA_ENCRYPTION_KEY,
    activeKeyId: env.PROVIDER_DATA_ENCRYPTION_KEY_ID,
    previousKeys: env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS,
    forbiddenMaterials: [env.PROVIDER_WALLET_PRIVATE_KEY, ...retainedSigningKeys],
  });
}
