import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { assertExactKeys, canonicalHash, canonicalJson } from "./canonical.js";

export interface CursorBinding {
  kind: string;
  environment: string;
  chainId: number;
  issuer: string;
  audience: string;
  payer: string;
  providerAgentId: string;
  queryHash: Hex;
}

export interface CursorOrderingTuple {
  createdAt: string;
  id: string;
}

interface CursorPlaintextV1 {
  kind: string;
  environment: string;
  payer: string;
  providerAgentId: string;
  queryHash: Hex;
  last: CursorOrderingTuple;
  issuedAt: number;
  validBefore: number;
}

export interface CursorKeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

function aad(binding: CursorBinding, keyId: string): Buffer {
  return Buffer.from(canonicalHash({
    version: "daski-cursor-a256gcm-v1",
    kind: binding.kind,
    environment: binding.environment,
    chainId: binding.chainId,
    issuer: binding.issuer,
    audience: binding.audience,
    keyId,
    payer: binding.payer.toLowerCase(),
    providerAgentId: binding.providerAgentId,
    queryHash: binding.queryHash,
  }).slice(2), "hex");
}

export function encryptCursor(args: {
  binding: CursorBinding;
  last: CursorOrderingTuple;
  keyRing: CursorKeyRing;
  now?: number;
  ttlSeconds?: number;
}): string {
  const key = args.keyRing.keys.get(args.keyRing.activeKeyId);
  if (!key || key.length !== 32) throw new Error("active cursor key unavailable");
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const ttl = args.ttlSeconds ?? 900;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 900) throw new Error("invalid cursor lifetime");
  const plaintext: CursorPlaintextV1 = {
    kind: args.binding.kind,
    environment: args.binding.environment,
    payer: args.binding.payer.toLowerCase(),
    providerAgentId: args.binding.providerAgentId,
    queryHash: args.binding.queryHash,
    last: args.last,
    issuedAt: now,
    validBefore: now + ttl,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(args.binding, args.keyRing.activeKeyId));
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(plaintext)), cipher.final()]);
  return `v1.${args.keyRing.activeKeyId}.${Buffer.concat([
    nonce, ciphertext, cipher.getAuthTag(),
  ]).toString("base64url")}`;
}

export function decryptCursor(args: {
  token: string;
  binding: CursorBinding;
  keyRing: CursorKeyRing;
  now?: number;
}): CursorOrderingTuple {
  const parts = args.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1] ?? "")) {
    throw new Error("invalid cursor");
  }
  const keyId = parts[1] as string;
  const key = args.keyRing.keys.get(keyId);
  const packed = Buffer.from(parts[2] ?? "", "base64url");
  if (!key || key.length !== 32 || packed.length < 29) throw new Error("invalid cursor");
  const nonce = packed.subarray(0, 12);
  const ciphertext = packed.subarray(12, -16);
  const tag = packed.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad(args.binding, keyId));
  decipher.setAuthTag(tag);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  assertExactKeys(parsed, [
    "kind", "environment", "payer", "providerAgentId", "queryHash", "last",
    "issuedAt", "validBefore",
  ], "cursor plaintext");
  const cursor = parsed as CursorPlaintextV1;
  assertExactKeys(cursor.last, ["createdAt", "id"], "cursor ordering tuple");
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  if (
    cursor.kind !== args.binding.kind || cursor.environment !== args.binding.environment ||
    cursor.payer !== args.binding.payer.toLowerCase() ||
    cursor.providerAgentId !== args.binding.providerAgentId ||
    cursor.queryHash !== args.binding.queryHash || cursor.issuedAt > now + 30 ||
    cursor.validBefore <= now || cursor.validBefore - cursor.issuedAt > 900 ||
    !Number.isSafeInteger(cursor.issuedAt) || !Number.isSafeInteger(cursor.validBefore) ||
    typeof cursor.last.createdAt !== "string" || typeof cursor.last.id !== "string"
  ) throw new Error("invalid cursor");
  return cursor.last;
}
