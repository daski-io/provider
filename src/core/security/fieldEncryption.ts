import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Authenticated field encryption for persisted private values, ported from
 * provider-full's protected-data primitive with the same envelope:
 *
 *   daski:v1:<base64url(JSON {v: 1, alg: "A256GCM", kid, purpose, iv, ciphertext, tag})>
 *
 * Each value is AES-256-GCM with a fresh 96-bit nonce under a key derived
 * per purpose (HKDF-SHA256) from a 32-byte master key, and its owning record
 * (purpose, table, record id, field, service) is bound as associated data,
 * so a value copied to another record or field does not decrypt.
 *
 * Key-id and rotation contract: every new value is encrypted with the active
 * key and names its key id; a value is decrypted only with the key its own
 * id names, active or previous. Rotating means configuring a new active key
 * under a new id and keeping the old one as a previous (read-only) key until
 * no stored value needs it; reusing an id for other key material is
 * detected (authentication fails) rather than silently accepted.
 */
export const FIELD_ENVELOPE_PREFIX = "daski:v1:";
export const FIELD_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ALGORITHM = "aes-256-gcm";
const ENVELOPE_ALGORITHM = "A256GCM";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const DERIVATION_SALT = "daski-provider/protected-data/v1";

export interface FieldEncryptionKeyRing {
  /** The key every new value is encrypted with; null when none is configured. */
  activeKeyId: string | null;
  /** Active and previous master keys by id. */
  keys: ReadonlyMap<string, Buffer>;
}

/** The owning record a value is bound to; supplied again, independently, to read it. */
export interface FieldContext {
  purpose: string;
  table: string;
  recordId: string;
  field: string;
  service?: string;
}

/** A value that cannot be produced or read; its message never includes key material or plaintext. */
export class FieldEncryptionError extends Error {
  constructor(message: string, readonly reason: "key_unavailable" | "malformed" | "unauthentic") {
    super(message);
    this.name = "FieldEncryptionError";
  }
}

const envelopeSchema = z.object({
  v: z.literal(1),
  alg: z.literal(ENVELOPE_ALGORITHM),
  kid: z.string().regex(FIELD_KEY_ID_PATTERN),
  purpose: z.string().min(1).max(128),
  iv: z.string().min(1).max(32),
  ciphertext: z.string(),
  tag: z.string().min(1).max(32),
}).strict();

type Envelope = z.infer<typeof envelopeSchema>;

const purposeKey = (master: Buffer, purpose: string): Buffer => Buffer.from(hkdfSync(
  "sha256", master, Buffer.from(DERIVATION_SALT, "utf8"), Buffer.from(`purpose:${purpose}`, "utf8"), KEY_BYTES,
));

function associatedData(context: FieldContext): Buffer {
  for (const [name, value] of Object.entries({
    purpose: context.purpose, table: context.table, recordId: context.recordId, field: context.field,
  })) {
    if (!value || value.length > 512) throw new FieldEncryptionError(`invalid encryption context ${name}`, "malformed");
  }
  // Fixed property order is the canonical associated-data form (as in full).
  return Buffer.from(JSON.stringify({
    v: 1,
    purpose: context.purpose,
    table: context.table,
    recordId: context.recordId,
    field: context.field,
    service: context.service ?? null,
    tenant: null,
    recordVersion: null,
  }), "utf8");
}

function decodeEnvelope(value: string): Envelope {
  if (typeof value !== "string" || !value.startsWith(FIELD_ENVELOPE_PREFIX)) {
    throw new FieldEncryptionError("unsupported encrypted value format", "malformed");
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(FIELD_ENVELOPE_PREFIX.length), "base64url").toString("utf8"),
    );
    return envelopeSchema.parse(decoded);
  } catch {
    throw new FieldEncryptionError("malformed encrypted value", "malformed");
  }
}

/** Encrypt with the active key; returns the envelope and the key id it names. */
export function encryptField(
  ring: FieldEncryptionKeyRing,
  plaintext: string,
  context: FieldContext,
): { ciphertext: string; keyId: string } {
  const keyId = ring.activeKeyId;
  const master = keyId === null ? undefined : ring.keys.get(keyId);
  if (keyId === null || !master) throw new FieldEncryptionError("no active encryption key is configured", "key_unavailable");
  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, purposeKey(master, context.purpose), iv);
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    alg: ENVELOPE_ALGORITHM,
    kid: keyId,
    purpose: context.purpose,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return {
    ciphertext: FIELD_ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url"),
    keyId,
  };
}

/** Decrypt only with the original record context and the key the value names. */
export function decryptField(ring: FieldEncryptionKeyRing, value: string, context: FieldContext): string {
  const envelope = decodeEnvelope(value);
  if (envelope.purpose !== context.purpose) {
    throw new FieldEncryptionError("encrypted value has another purpose", "unauthentic");
  }
  const master = ring.keys.get(envelope.kid);
  if (!master) {
    throw new FieldEncryptionError(`encryption key '${envelope.kid}' is not configured`, "key_unavailable");
  }
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (iv.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new FieldEncryptionError("malformed encrypted value", "malformed");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, purposeKey(master, context.purpose), iv);
    decipher.setAAD(associatedData(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new FieldEncryptionError("encrypted value does not authenticate for its record", "unauthentic");
  }
}

/** The key id a stored value names, read without decrypting it. */
export function fieldKeyId(value: string): string {
  return decodeEnvelope(value).kid;
}

const masterKey = (value: string, label: string): Buffer => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) {
    throw new Error(`${label} must be a non-zero 32-byte 0x key`);
  }
  return Buffer.from(value.slice(2), "hex");
};

/**
 * The configured key ring: an optional active key with its id, and
 * previous read-only keys as comma-separated `id=0x<64 hex>` entries. Ids
 * are unique, key material is never reused under another id, and no
 * encryption key may equal a signing key the provider holds.
 */
export function parseFieldEncryptionKeys(args: {
  activeKey?: string;
  activeKeyId: string;
  previousKeys: string;
  forbiddenMaterials?: readonly string[];
}): FieldEncryptionKeyRing {
  const keys = new Map<string, Buffer>();
  const materials = new Set((args.forbiddenMaterials ?? []).map((value) => value.toLowerCase()));
  const add = (id: string, value: string, label: string) => {
    if (!FIELD_KEY_ID_PATTERN.test(id)) throw new Error(`${label} key id must be 1 to 64 of A-Z a-z 0-9 . _ -`);
    const material = value.toLowerCase();
    if (keys.has(id)) throw new Error(`${label} key ids must be unique`);
    if (materials.has(material)) throw new Error(`${label} must not reuse a signing key or another key id's material`);
    keys.set(id, masterKey(value, label));
    materials.add(material);
  };
  const active = args.activeKey?.trim();
  if (active) add(args.activeKeyId, active, "PROVIDER_DATA_ENCRYPTION_KEY");
  for (const raw of args.previousKeys.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS entries must be id=0x<64 hex>");
    add(entry.slice(0, separator), entry.slice(separator + 1), "PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS");
  }
  return { activeKeyId: active ? args.activeKeyId : null, keys };
}
