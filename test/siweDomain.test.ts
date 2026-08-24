import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const state = vi.hoisted(() => ({
  nonces: new Set<string>(),
  rateAllowed: true,
  rateScopes: [] as string[],
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    CHAIN_ID: 84532,
    BASE_URL: "https://provider.example.com",
    ADMIN_WALLET_ALLOWLIST: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  },
}));
vi.mock("../src/core/db/queries/authSecurity.js", () => ({
  consumeAuthRateLimit: vi.fn(async ({ scope }: { scope: string }) => {
    state.rateScopes.push(scope);
    return state.rateAllowed;
  }),
  storeSiweNonce: vi.fn(async ({ nonce }: { nonce: string }) => {
    if (state.nonces.has(nonce)) return false;
    state.nonces.add(nonce);
    return true;
  }),
  consumeSiweNonce: vi.fn(async (nonce: string) => state.nonces.delete(nonce)),
}));

import {
  expectedSiweDomain,
  expectedSiweUri,
  issueSiweNonce,
  verifySiweSignIn,
} from "../src/core/auth/siwe.js";

const KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OTHER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(KEY);
const otherAccount = privateKeyToAccount(OTHER_KEY);

function siweMessage(args: {
  nonce: string;
  domain?: string;
  uri?: string;
  version?: string;
  chainId?: number;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
}): string {
  const lines = [
    `${args.domain ?? "provider.example.com"} wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "Sign in to the Daski admin UI.",
    "",
    `URI: ${args.uri ?? "https://provider.example.com"}`,
    `Version: ${args.version ?? "1"}`,
    `Chain ID: ${args.chainId ?? 84532}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt ?? new Date().toISOString()}`,
  ];
  if (args.expirationTime) lines.push(`Expiration Time: ${args.expirationTime}`);
  if (args.notBefore) lines.push(`Not Before: ${args.notBefore}`);
  return lines.join("\n");
}

async function signedResult(
  nonce: string,
  overrides: Omit<Parameters<typeof siweMessage>[0], "nonce"> = {},
) {
  const message = siweMessage({ nonce, ...overrides });
  return verifySiweSignIn({
    message,
    signature: await account.signMessage({ message }),
    requestIp: "203.0.113.10",
  });
}

beforeEach(() => {
  state.nonces.clear();
  state.rateAllowed = true;
  state.rateScopes.length = 0;
});

describe("SIWE exact scope and standards validation", () => {
  it("derives exact domain and URI only from BASE_URL", () => {
    process.env.HOST_OVERRIDE = "evil.example";
    expect(expectedSiweDomain()).toBe("provider.example.com");
    expect(expectedSiweUri()).toBe("https://provider.example.com");
    delete process.env.HOST_OVERRIDE;
  });

  it.each([
    ["wrong domain", { domain: "evil.example" }, "wrong-domain"],
    ["wrong URI", { uri: "https://evil.example" }, "wrong-uri"],
    ["wrong version", { version: "2" }, "malformed-message"],
    ["wrong chain", { chainId: 1 }, "wrong-chain"],
  ] as const)("rejects %s", async (_label, override, reason) => {
    const issued = await issueSiweNonce("203.0.113.10");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(await signedResult(issued.nonce, override)).toEqual({ ok: false, reason });
  });

  it("rejects stale issuance, expiry, future not-before, and malformed dates", async () => {
    const cases = [
      [{ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, "issued-at-stale"],
      [{ expirationTime: new Date(Date.now() - 1_000).toISOString() }, "expired"],
      [{ notBefore: new Date(Date.now() + 60_000).toISOString() }, "not-yet-valid"],
      [{ expirationTime: "not-a-date" }, "malformed-message"],
    ] as const;
    for (const [override, reason] of cases) {
      const issued = await issueSiweNonce("203.0.113.10");
      if (!issued.ok) throw new Error("nonce issue failed");
      expect(await signedResult(issued.nonce, override)).toEqual({ ok: false, reason });
    }
  });

  it("accepts once, rejects replay, and has one winner under concurrency", async () => {
    const first = await issueSiweNonce("203.0.113.10");
    if (!first.ok) throw new Error("nonce issue failed");
    expect((await signedResult(first.nonce)).ok).toBe(true);
    expect(await signedResult(first.nonce)).toEqual({
      ok: false,
      reason: "nonce-not-recognized",
    });

    const concurrent = await issueSiweNonce("203.0.113.10");
    if (!concurrent.ok) throw new Error("nonce issue failed");
    const message = siweMessage({ nonce: concurrent.nonce });
    const signature = await account.signMessage({ message });
    const outcomes = await Promise.all([
      verifySiweSignIn({ message, signature, requestIp: "203.0.113.10" }),
      verifySiweSignIn({ message, signature, requestIp: "203.0.113.10" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });

  it("rejects a signature from a different wallet and applies upstream limits", async () => {
    const issued = await issueSiweNonce("203.0.113.10");
    if (!issued.ok) throw new Error("nonce issue failed");
    const message = siweMessage({ nonce: issued.nonce });
    expect(
      await verifySiweSignIn({
        message,
        signature: await otherAccount.signMessage({ message }),
        requestIp: "203.0.113.10",
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });
    expect(state.rateScopes).not.toContain("siwe-verify-wallet");

    state.rateAllowed = false;
    expect(await issueSiweNonce("203.0.113.10")).toEqual({
      ok: false,
      reason: "rate-limited",
    });
  });

  it("rejects oversized UTF-8 messages and non-standard signature lengths before throttling", async () => {
    const oversizedUnicode = "😀".repeat(3_000);
    expect(oversizedUnicode.length).toBeLessThan(8_192);
    expect(
      await verifySiweSignIn({
        message: oversizedUnicode,
        signature: `0x${"00".repeat(65)}`,
        requestIp: "203.0.113.10",
      }),
    ).toEqual({ ok: false, reason: "malformed-message" });
    expect(state.rateScopes).toHaveLength(0);

    expect(
      await verifySiweSignIn({
        message: "short",
        signature: `0x${"00".repeat(66)}`,
        requestIp: "203.0.113.10",
      }),
    ).toEqual({ ok: false, reason: "malformed-message" });
    expect(state.rateScopes).toHaveLength(0);
  });
});
