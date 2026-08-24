import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  createHmac,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";

const ENVELOPE_PREFIX = "daski:v1:";
const ALGORITHM = "aes-256-gcm";
const ENVELOPE_ALGORITHM = "A256GCM";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptionContext {
  /** Cryptographic purpose; keys are derived independently per purpose. */
  purpose: string;
  /** Database/object-store collection that owns the protected value. */
  table: string;
  /** Stable owning record identifier supplied independently at read time. */
  recordId: string;
  /** Column or structured field path. */
  field: string;
  service?: string;
  tenant?: string;
  recordVersion?: string | number;
}

const envelopeSchema = z.object({
  v: z.literal(1),
  alg: z.literal(ENVELOPE_ALGORITHM),
  kid: z.string().min(1).max(64),
  purpose: z.string().min(1).max(128),
  iv: z.string().min(1),
  ciphertext: z.string(),
  tag: z.string().min(1),
});

type EncryptionEnvelope = z.infer<typeof envelopeSchema>;

function activeMasterKey(): Buffer {
  if (!config.PROVIDER_DATA_ENCRYPTION_KEY) {
    throw new Error("PROVIDER_DATA_ENCRYPTION_KEY is required for protected data");
  }
  return Buffer.from(config.PROVIDER_DATA_ENCRYPTION_KEY.slice(2), "hex");
}

function previousMasterKeys(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const rawEntry of config.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("invalid previous encryption key entry");
    const id = entry.slice(0, separator);
    const key = entry.slice(separator + 1);
    keys.set(id, Buffer.from(key.slice(2), "hex"));
  }
  return keys;
}

function masterKeyForRead(keyId: string): Buffer {
  if (keyId === config.PROVIDER_DATA_ENCRYPTION_KEY_ID) return activeMasterKey();
  const key = previousMasterKeys().get(keyId);
  if (!key) throw new Error(`encryption key '${keyId}' is unavailable or retired`);
  return key;
}

function purposeKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.from("daski-provider/protected-data/v1", "utf8"),
      Buffer.from(`purpose:${purpose}`, "utf8"),
      KEY_BYTES,
    ),
  );
}

function validateContext(context: EncryptionContext): void {
  for (const [field, value] of Object.entries({
    purpose: context.purpose,
    table: context.table,
    recordId: context.recordId,
    field: context.field,
  })) {
    if (!value || value.length > 512) {
      throw new Error(`invalid encryption context ${field}`);
    }
  }
}

function authenticatedContext(context: EncryptionContext): Buffer {
  validateContext(context);
  // Fixed property order is the canonical AAD representation.
  return Buffer.from(JSON.stringify({
    v: 1,
    purpose: context.purpose,
    table: context.table,
    recordId: context.recordId,
    field: context.field,
    service: context.service ?? null,
    tenant: context.tenant ?? null,
    recordVersion: context.recordVersion === undefined
      ? null
      : String(context.recordVersion),
  }), "utf8");
}

function encodeEnvelope(envelope: EncryptionEnvelope): string {
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeEnvelope(value: string): EncryptionEnvelope {
  if (!value.startsWith(ENVELOPE_PREFIX)) {
    throw new Error("unsupported protected-data envelope version");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed protected-data envelope");
  }
  return envelopeSchema.parse(decoded);
}

/** Encrypt a value with a purpose-derived key and record-bound AAD. */
export function encryptString(plaintext: string, context: EncryptionContext): string {
  const aad = authenticatedContext(context);
  const iv = randomBytes(NONCE_BYTES);
  const key = purposeKey(activeMasterKey(), context.purpose);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return encodeEnvelope({
    v: 1,
    alg: ENVELOPE_ALGORITHM,
    kid: config.PROVIDER_DATA_ENCRYPTION_KEY_ID,
    purpose: context.purpose,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

/** Decrypt only when the caller supplies the original owning-record context. */
export function decryptString(value: string, context: EncryptionContext): string {
  const envelope = decodeEnvelope(value);
  if (envelope.purpose !== context.purpose) {
    throw new Error("protected-data purpose mismatch");
  }
  const aad = authenticatedContext(context);
  const key = purposeKey(masterKeyForRead(envelope.kid), context.purpose);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function inspectEncryptionEnvelope(value: string): {
  version: number;
  algorithm: string;
  keyId: string;
  purpose: string;
  needsRotation: boolean;
} {
  const envelope = decodeEnvelope(value);
  return {
    version: envelope.v,
    algorithm: envelope.alg,
    keyId: envelope.kid,
    purpose: envelope.purpose,
    needsRotation: envelope.kid !== config.PROVIDER_DATA_ENCRYPTION_KEY_ID,
  };
}

/** Keyed equality index for values that must remain searchable without plaintext. */
export function protectedLookupHash(value: string, purpose: string): string {
  const key = purposeKey(activeMasterKey(), `lookup:${purpose}`);
  const digest = createHmac("sha256", key)
    .update(value.trim().toLowerCase(), "utf8")
    .digest("hex");
  return `${config.PROVIDER_DATA_ENCRYPTION_KEY_ID}:${digest}`;
}

/** Active and previous-key candidates support equality lookups during rotation. */
export function protectedLookupHashes(value: string, purpose: string): string[] {
  const normalized = value.trim().toLowerCase();
  const keys = new Map<string, Buffer>([
    [config.PROVIDER_DATA_ENCRYPTION_KEY_ID, activeMasterKey()],
    ...previousMasterKeys(),
  ]);
  return [...keys].map(([keyId, master]) => {
    const key = purposeKey(master, `lookup:${purpose}`);
    const digest = createHmac("sha256", key).update(normalized, "utf8").digest("hex");
    return `${keyId}:${digest}`;
  });
}
