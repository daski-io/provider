import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { SignedEnvelope } from "./types.js";
import type { ProviderWalletConfig } from "./walletConfig.js";
import { privateKeyToAccount } from "viem/accounts";

export async function signProviderResponse<T>(args: {
  artifactType: string;
  payload: T;
  standard: ProviderStandardRailConfig;
  wallet: ProviderWalletConfig;
  chainId: number;
  grantDeadline: number;
}): Promise<SignedEnvelope<T>> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: 1 as const,
    environment: args.standard.environment,
    chainId: args.chainId,
    audience: args.standard.gatewayAudience,
    signerKeyId: args.wallet.assetResponseKeyId,
    issuedAt,
    validBefore: Math.min(issuedAt + 60, args.grantDeadline),
    payload: args.payload,
  };
  return {
    ...unsigned,
    signature: await privateKeyToAccount(args.wallet.assetResponsePrivateKey).signMessage({
      message: { raw: canonicalHash(unsigned) },
    }),
  };
}
