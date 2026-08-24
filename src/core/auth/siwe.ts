import {
  SiweMessage,
  generateNonce as generateSiweNonce,
  type SiweConfig,
} from "@signinwithethereum/siwe";
import {
  getAddress,
  hashMessage,
  recoverMessageAddress,
  type Hex,
} from "viem";
import { config } from "../config.js";
import {
  consumeAuthRateLimit,
  consumeSiweNonce,
  storeSiweNonce,
} from "../db/queries/authSecurity.js";

export const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
export const SIWE_ISSUED_AT_MAX_AGE_MS = 5 * 60 * 1000;
export const SIWE_MAX_FUTURE_SKEW_MS = 60 * 1000;
export const SIWE_MAX_MESSAGE_BYTES = 8_192;
export const SIWE_SIGNATURE_HEX_LENGTH = 132;

const verifierConfig: SiweConfig = {
  verifyMessage(message, signature) {
    return recoverMessageAddress({ message, signature: signature as Hex });
  },
  hashMessage,
  getAddress,
};

function loadAllowlist(): Set<string> {
  const raw = config.ADMIN_WALLET_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^0x[0-9a-f]{40}$/.test(value)),
  );
}

export function isAllowlistConfigured(): boolean {
  return loadAllowlist().size > 0;
}

export function isWalletAllowed(address: string): boolean {
  return loadAllowlist().has(address.toLowerCase());
}

export function expectedSiweDomain(): string {
  return new URL(config.BASE_URL).host;
}

export function expectedSiweUri(): string {
  return new URL(config.BASE_URL).origin;
}

export type NonceIssueResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: "rate-limited" | "nonce-pool-full" };

/** Issue a shared, expiring nonce after both IP and global throttles. */
export async function issueSiweNonce(requestIp: string): Promise<NonceIssueResult> {
  const [globalAllowed, ipAllowed] = await Promise.all([
    consumeAuthRateLimit({
      scope: "siwe-nonce-global",
      identity: "global",
      limit: 300,
      windowSeconds: 60,
    }),
    consumeAuthRateLimit({
      scope: "siwe-nonce-ip",
      identity: requestIp,
      limit: 10,
      windowSeconds: 60,
    }),
  ]);
  if (!globalAllowed || !ipAllowed) return { ok: false, reason: "rate-limited" };

  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = generateSiweNonce();
    const stored = await storeSiweNonce({
      nonce,
      requestIp,
      expiresAt: new Date(Date.now() + SIWE_NONCE_TTL_MS),
    });
    if (stored) return { ok: true, nonce };
  }
  return { ok: false, reason: "nonce-pool-full" };
}

export type VerifyFailureReason =
  | "malformed-message"
  | "bad-signature"
  | "wrong-chain"
  | "wrong-domain"
  | "wrong-uri"
  | "wrong-version"
  | "issued-at-stale"
  | "expired"
  | "not-yet-valid"
  | "nonce-not-recognized"
  | "wallet-not-allowed"
  | "rate-limited";

export type VerifyResult =
  | { ok: true; address: string }
  | { ok: false; reason: VerifyFailureReason };

export interface VerifyArgs {
  message: string;
  signature: Hex;
  requestIp: string;
  now?: Date;
}

export function siwePayloadTooLarge(message: string, signature: string): boolean {
  return Buffer.byteLength(message, "utf8") > SIWE_MAX_MESSAGE_BYTES
    || signature.length > SIWE_SIGNATURE_HEX_LENGTH;
}

function parsedDate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse and verify the complete EIP-4361 message before atomically burning its nonce. */
export async function verifySiweSignIn(args: VerifyArgs): Promise<VerifyResult> {
  if (siwePayloadTooLarge(args.message, args.signature)
    || !/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
    return { ok: false, reason: "malformed-message" };
  }
  const [globalAllowed, ipAllowed] = await Promise.all([
    consumeAuthRateLimit({
      scope: "siwe-verify-global",
      identity: "global",
      limit: 120,
      windowSeconds: 60,
    }),
    consumeAuthRateLimit({
      scope: "siwe-verify-ip",
      identity: args.requestIp,
      limit: 10,
      windowSeconds: 60,
    }),
  ]);
  if (!globalAllowed || !ipAllowed) return { ok: false, reason: "rate-limited" };

  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(args.message);
  } catch {
    return { ok: false, reason: "malformed-message" };
  }

  if (parsed.domain !== expectedSiweDomain()) return { ok: false, reason: "wrong-domain" };
  if (parsed.uri !== expectedSiweUri()) return { ok: false, reason: "wrong-uri" };
  if (parsed.version !== "1") return { ok: false, reason: "wrong-version" };
  if (parsed.chainId !== config.CHAIN_ID) return { ok: false, reason: "wrong-chain" };

  const now = args.now?.getTime() ?? Date.now();
  const issuedAt = parsedDate(parsed.issuedAt);
  if (
    issuedAt === null ||
    issuedAt < now - SIWE_ISSUED_AT_MAX_AGE_MS ||
    issuedAt > now + SIWE_MAX_FUTURE_SKEW_MS
  ) {
    return { ok: false, reason: "issued-at-stale" };
  }
  if (parsed.expirationTime !== undefined) {
    const expiration = parsedDate(parsed.expirationTime);
    if (expiration === null) return { ok: false, reason: "malformed-message" };
    if (expiration <= now) return { ok: false, reason: "expired" };
  }
  if (parsed.notBefore !== undefined) {
    const notBefore = parsedDate(parsed.notBefore);
    if (notBefore === null) return { ok: false, reason: "malformed-message" };
    if (notBefore > now) return { ok: false, reason: "not-yet-valid" };
  }

  const verification = await parsed.verify(
    {
      signature: args.signature,
      domain: expectedSiweDomain(),
      nonce: parsed.nonce,
      uri: expectedSiweUri(),
      chainId: config.CHAIN_ID,
      time: new Date(now).toISOString(),
    },
    { config: verifierConfig, strict: true, suppressExceptions: true },
  );
  if (!verification.success) return { ok: false, reason: "bad-signature" };
  // Charge the wallet-specific bucket only after the signature proves control
  // of that wallet. Otherwise anyone could exhaust another operator's bucket
  // by placing the victim address in malformed or incorrectly signed text.
  const walletAllowed = await consumeAuthRateLimit({
    scope: "siwe-verify-wallet",
    identity: parsed.address,
    limit: 5,
    windowSeconds: 60,
  });
  if (!walletAllowed) return { ok: false, reason: "rate-limited" };
  if (!isWalletAllowed(parsed.address)) return { ok: false, reason: "wallet-not-allowed" };
  if (!(await consumeSiweNonce(parsed.nonce))) {
    return { ok: false, reason: "nonce-not-recognized" };
  }
  return { ok: true, address: parsed.address.toLowerCase() };
}
