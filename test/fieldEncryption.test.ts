import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import {
  decryptField,
  encryptField,
  FIELD_ENVELOPE_PREFIX,
  FieldEncryptionError,
  fieldKeyId,
  parseFieldEncryptionKeys,
  type FieldContext,
} from "../src/core/security/fieldEncryption.js";

const key = (byte: string) => `0x${byte.repeat(32)}`;
const ring = (active = key("a1"), previous = "") => parseFieldEncryptionKeys({
  activeKey: active,
  activeKeyId: "k2",
  previousKeys: previous,
});
const context: FieldContext = {
  purpose: "external-job/input",
  table: "provider_external_jobs",
  recordId: "task-1",
  field: "input_ciphertext",
  service: "synthetic-audit",
};

const failure = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof FieldEncryptionError) return error.reason;
    throw error;
  }
  throw new Error("expected a field encryption failure");
};

describe("authenticated field encryption", () => {
  it("round-trips a value bound to its record and names the active key id", () => {
    const sealed = encryptField(ring(), '{"description":"secret plan"}', context);
    expect(sealed.keyId).toBe("k2");
    expect(sealed.ciphertext.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    expect(sealed.ciphertext).not.toContain("secret");
    expect(fieldKeyId(sealed.ciphertext)).toBe("k2");
    expect(decryptField(ring(), sealed.ciphertext, context)).toBe('{"description":"secret plan"}');
    // A fresh nonce per value: equal plaintexts never produce equal envelopes.
    expect(encryptField(ring(), "x", context).ciphertext).not.toBe(encryptField(ring(), "x", context).ciphertext);
  });

  it("refuses a value moved to another record, field, purpose or service", () => {
    const sealed = encryptField(ring(), "reference", context).ciphertext;
    for (const moved of [
      { ...context, recordId: "task-2" },
      { ...context, field: "job_reference_ciphertext" },
      { ...context, table: "other" },
      { ...context, service: "other-service" },
    ]) expect(failure(() => decryptField(ring(), sealed, moved))).toBe("unauthentic");
    expect(failure(() => decryptField(ring(), sealed, { ...context, purpose: "external-job/reference" })))
      .toBe("unauthentic");
  });

  it("decrypts with the key a value names and rotates new values to the active key", () => {
    const before = encryptField(ring(), "old", context).ciphertext;
    // Rotation: a new active key under a new id, the old one kept read-only.
    const rotated = parseFieldEncryptionKeys({
      activeKey: key("b2"), activeKeyId: "k3", previousKeys: `k2=${key("a1")}`,
    });
    expect(decryptField(rotated, before, context)).toBe("old");
    const after = encryptField(rotated, "new", context);
    expect(after.keyId).toBe("k3");
    // Retiring the previous key strands only the values that still name it.
    const retired = parseFieldEncryptionKeys({ activeKey: key("b2"), activeKeyId: "k3", previousKeys: "" });
    expect(decryptField(retired, after.ciphertext, context)).toBe("new");
    expect(failure(() => decryptField(retired, before, context))).toBe("key_unavailable");
    // Reusing an id for other material is detected, never accepted.
    const reused = parseFieldEncryptionKeys({ activeKey: key("c3"), activeKeyId: "k2", previousKeys: "" });
    expect(failure(() => decryptField(reused, before, context))).toBe("unauthentic");
  });

  it("refuses tampered or malformed envelopes and encryption without an active key", () => {
    const sealed = encryptField(ring(), "value", context).ciphertext;
    const envelope = JSON.parse(Buffer.from(sealed.slice(FIELD_ENVELOPE_PREFIX.length), "base64url").toString());
    const reseal = (patch: Record<string, unknown>) => FIELD_ENVELOPE_PREFIX
      + Buffer.from(JSON.stringify({ ...envelope, ...patch })).toString("base64url");
    const flipped = Buffer.from(envelope.ciphertext, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(failure(() => decryptField(ring(), reseal({ ciphertext: flipped.toString("base64url") }), context)))
      .toBe("unauthentic");
    expect(failure(() => decryptField(ring(), reseal({ extra: true }), context))).toBe("malformed");
    expect(failure(() => decryptField(ring(), reseal({ iv: "AA" }), context))).toBe("malformed");
    expect(failure(() => decryptField(ring(), reseal({ kid: "missing" }), context))).toBe("key_unavailable");
    expect(failure(() => decryptField(ring(), "daski:v2:abc", context))).toBe("malformed");
    expect(failure(() => decryptField(ring(), `${FIELD_ENVELOPE_PREFIX}not-json`, context))).toBe("malformed");
    const empty = parseFieldEncryptionKeys({ activeKeyId: "primary", previousKeys: `k2=${key("a1")}` });
    expect(empty.activeKeyId).toBeNull();
    expect(failure(() => encryptField(empty, "value", context))).toBe("key_unavailable");
    expect(decryptField(empty, sealed, context)).toBe("value");
  });

  it("reads provider-full's protected-data envelope byte for byte", () => {
    // An independent implementation of provider-full's encryptString
    // (src/core/chain/encryption.ts): same derivation, AAD and envelope.
    const master = Buffer.from(key("a1").slice(2), "hex");
    const derived = Buffer.from(hkdfSync("sha256", master, Buffer.from("daski-provider/protected-data/v1"),
      Buffer.from(`purpose:${context.purpose}`), 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(Buffer.from(JSON.stringify({
      v: 1, purpose: context.purpose, table: context.table, recordId: context.recordId,
      field: context.field, service: context.service, tenant: null, recordVersion: null,
    })));
    const ciphertext = Buffer.concat([cipher.update("full-format", "utf8"), cipher.final()]);
    const envelope = `daski:v1:${Buffer.from(JSON.stringify({
      v: 1, alg: "A256GCM", kid: "k2", purpose: context.purpose, iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
    })).toString("base64url")}`;
    expect(decryptField(ring(), envelope, context)).toBe("full-format");
  });

  it("refuses key rings that reuse ids, material or a signing key", () => {
    expect(() => ring(key("a1"), `k2=${key("b2")}`)).toThrow(/unique/);
    expect(() => ring(key("a1"), `k1=${key("a1")}`)).toThrow(/reuse/);
    expect(() => ring(key("a1"), "k1")).toThrow(/id=0x/);
    expect(() => ring(key("a1"), "bad id=0x" + "11".repeat(32))).toThrow(/key id/);
    expect(() => ring(key("00"))).toThrow(/non-zero/);
    expect(() => ring("0x1234")).toThrow(/32-byte/);
    expect(() => parseFieldEncryptionKeys({
      activeKey: key("44"), activeKeyId: "k2", previousKeys: "", forbiddenMaterials: [key("44")],
    })).toThrow(/signing key/);
  });

  it("validates the key ring in configuration, which is optional for synchronous installs", () => {
    const base = {
      BASE_URL: "https://provider.example", GATEWAY_BASE_URL: "https://gateway.example",
      PROVIDER_NAME: "Example", MARKETPLACE_TERMS_URL: "https://daski.example/terms",
      MARKETPLACE_PRIVACY_URL: "https://daski.example/privacy", PROVIDER_TERMS_URL: "https://provider.example/terms",
      PROVIDER_PRIVACY_URL: "https://provider.example/privacy", SUPPORT_EMAIL: "support@provider.example",
      DATABASE_URL: "postgresql://runtime:secret@db.example/provider", CHAIN_ID: "84532",
      BASE_RPC_URL: "https://rpc.example", PROVIDER_WALLET_PRIVATE_KEY: key("44"), PROVIDER_AGENT_ID: "1",
      IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      RATE_LIMIT_HASH_KEY: "a-secure-rate-limit-key-1234567890-ABCDEFG",
    };
    expect(parseConfig(base)).toMatchObject({ PROVIDER_DATA_ENCRYPTION_KEY_ID: "primary" });
    expect(parseConfig({ ...base, PROVIDER_DATA_ENCRYPTION_KEY: key("a1") }).PROVIDER_DATA_ENCRYPTION_KEY)
      .toBe(key("a1"));
    for (const invalid of [
      { PROVIDER_DATA_ENCRYPTION_KEY: key("00") },
      { PROVIDER_DATA_ENCRYPTION_KEY: key("44") },
      { PROVIDER_DATA_ENCRYPTION_KEY: key("a1"), PROVIDER_DATA_ENCRYPTION_KEY_ID: "bad id" },
      { PROVIDER_DATA_ENCRYPTION_KEY: key("a1"), PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS: `primary=${key("b2")}` },
    ]) expect(() => parseConfig({ ...base, ...invalid }), JSON.stringify(invalid)).toThrow(/PROVIDER_DATA_ENCRYPTION/);
  });
});
