import { describe, expect, it } from "vitest";
import { externalJobIdempotencyKey, type JobOperationIdentity } from "../src/core/externalJobs/idempotency.js";
import {
  boundedJobReference,
  jobInputFits,
  MAX_JOB_INPUT_BYTES,
  MAX_JOB_REFERENCE_BYTES,
  openJobField,
  sealJobField,
  sealResultCandidate,
} from "../src/core/externalJobs/jobCodec.js";
import { jobKeys } from "./externalJobFixture.js";

const identity: JobOperationIdentity = {
  environment: "testnet",
  chainId: 84532,
  providerAgentId: "8327",
  gatewayAudience: "https://gateway.example",
  orderId: "ord_00000000-0000-4000-8000-000000000001",
  serviceSlug: "synthetic-audit",
  skillId: "audit",
};
const job = { taskId: "task-1", serviceSlug: "synthetic-audit" };

describe("stable external-job idempotency key", () => {
  it("is one RFC 9562 version-8 UUID per admitted order and operation", () => {
    const key = externalJobIdempotencyKey(identity);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Deterministic: a retry, restart or upgrade derives the same key, and no
    // clock, attempt or process input exists to change it.
    expect(externalJobIdempotencyKey({ ...identity })).toBe(key);
    // Golden value: SHA-256 of the canonical JSON derivation input, version and
    // variant bits set (docs/architecture.md documents the derivation).
    expect(key).toBe("22a1e267-8015-8d31-bbfb-c0daa75d54b1");
  });

  it("differs for every other environment, chain, provider, gateway, order, service or skill", () => {
    const key = externalJobIdempotencyKey(identity);
    const variants: Array<Partial<JobOperationIdentity>> = [
      { environment: "mainnet" }, { chainId: 8453 }, { providerAgentId: "8328" },
      { gatewayAudience: "https://gateway.other" }, { orderId: `${identity.orderId}2` },
      { serviceSlug: "other" }, { skillId: "other" },
    ];
    const keys = variants.map((variant) => externalJobIdempotencyKey({ ...identity, ...variant }));
    expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
  });
});

describe("external-job field codec", () => {
  it("seals input and references to their own job row and column", () => {
    const sealed = sealJobField(jobKeys(), "input", job, { description: "audit this" });
    expect(sealed.keyId).toBe("k1");
    expect(openJobField(jobKeys(), "input", job, sealed)).toEqual({ description: "audit this" });
    expect(() => openJobField(jobKeys(), "reference", job, sealed)).toThrow();
    expect(() => openJobField(jobKeys(), "input", { ...job, taskId: "task-2" }, sealed)).toThrow();
    // The key id stored beside the envelope must be the one it names.
    expect(() => openJobField(jobKeys(), "input", job, { ...sealed, keyId: "k0" })).toThrow(/another key/);
  });

  it("bounds job references to small plain JSON objects", () => {
    expect(boundedJobReference({ jobId: "j-1", resultUrl: "https://audit.example/r/1" }))
      .toEqual({ jobId: "j-1", resultUrl: "https://audit.example/r/1" });
    for (const invalid of [null, "j-1", ["j-1"], 7, { nested: { too: { deep: 1 } }, ...deep(30) },
      { blob: "x".repeat(MAX_JOB_REFERENCE_BYTES) }, { ["__proto__"]: 1 }]) {
      expect(boundedJobReference(invalid), JSON.stringify(invalid)?.slice(0, 40)).toBeNull();
    }
    // A snapshot: getters and prototypes do not survive into the stored form.
    const tricky = { jobId: "j-2", get later() { return "computed"; } };
    expect(boundedJobReference(tricky)).toEqual({ jobId: "j-2", later: "computed" });
    expect(boundedJobReference({ jobId: "j-3", missing: undefined })).toEqual({ jobId: "j-3" });
  });

  it("keeps a result candidate only when it is storable within the result bound", () => {
    expect(sealResultCandidate(jobKeys(), job, { status: "completed", note: "x" })).toMatchObject({ keyId: "k1" });
    expect(sealResultCandidate(jobKeys(), job, { status: "completed", note: "x".repeat(1_000_001) })).toBeNull();
    expect(sealResultCandidate(jobKeys(), job, { value: Number.NaN })).toBeNull();
    expect(jobInputFits({ description: "short" })).toBe(true);
    expect(jobInputFits({ description: "x".repeat(MAX_JOB_INPUT_BYTES) })).toBe(false);
  });
});

function deep(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < levels; level += 1) value = { next: value };
  return { deep: value };
}
