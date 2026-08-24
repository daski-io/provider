import { describe, it, expect } from "vitest";

// The encryption module reads PROVIDER_DATA_ENCRYPTION_KEY from config
// at function-call time. Set it via process.env BEFORE the module is
// imported.
process.env.PROVIDER_DATA_ENCRYPTION_KEY =
  "0x" + "11".repeat(32);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
process.env.ADMIN_TOKEN =
  process.env.ADMIN_TOKEN ?? "test-admin-token-0123456789abcdef";
process.env.BASE_URL = process.env.BASE_URL ?? "http://localhost:4000";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://localhost/test";
process.env.BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://example.com";
process.env.CHAIN_ID = process.env.CHAIN_ID ?? "84532";
process.env.PROVIDER_WALLET_PRIVATE_KEY =
  "0x" + "22".repeat(32);
process.env.IDENTITY_REGISTRY_ADDRESS =
  process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x" + "33".repeat(20);
process.env.PROVIDER_REGISTRY_ADDRESS =
  process.env.PROVIDER_REGISTRY_ADDRESS ?? "0x" + "88".repeat(20);
process.env.USDC_ADDRESS = process.env.USDC_ADDRESS ?? "0x" + "99".repeat(20);
process.env.PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Test Provider";
process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? "support@example.com";

const { encryptString, decryptString } = await import(
  "../src/core/chain/encryption.js"
);

const context = {
  purpose: "test-secret",
  table: "test_records",
  recordId: "record-1",
  field: "secret",
} as const;

describe("encryption (AES-256-GCM)", () => {
  it("round-trips ASCII strings", () => {
    const plaintext = "EPP-AUTH-CODE-12345";
    const cipher = encryptString(plaintext, context);
    expect(cipher).not.toBe(plaintext);
    expect(decryptString(cipher, context)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random nonce)", () => {
    const plaintext = "same input";
    const a = encryptString(plaintext, context);
    const b = encryptString(plaintext, context);
    expect(a).not.toBe(b);
    expect(decryptString(a, context)).toBe(plaintext);
    expect(decryptString(b, context)).toBe(plaintext);
  });

  it("rejects tampered envelopes", () => {
    const plaintext = "secret";
    const cipher = encryptString(plaintext, context);
    const encoded = cipher.slice("daski:v1:".length);
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    envelope.ciphertext = envelope.ciphertext.slice(0, -1) +
      (envelope.ciphertext.endsWith("A") ? "B" : "A");
    const tampered = "daski:v1:" + Buffer.from(JSON.stringify(envelope)).toString("base64url");
    expect(() => decryptString(tampered, context)).toThrow();
  });

  it("rejects truncated envelopes", () => {
    const plaintext = "secret";
    const cipher = encryptString(plaintext, context);
    const truncated = cipher.slice(0, 16);
    expect(() => decryptString(truncated, context)).toThrow();
  });

  it("binds ciphertext to its purpose and owning record", () => {
    const cipher = encryptString("secret", context);
    expect(() => decryptString(cipher, { ...context, recordId: "record-2" })).toThrow();
    expect(() => decryptString(cipher, { ...context, purpose: "other-purpose" })).toThrow();
  });

  it("rejects values outside the authenticated envelope format", () => {
    expect(() => decryptString(Buffer.alloc(48).toString("base64"), context))
      .toThrow("unsupported protected-data envelope version");
  });
});
