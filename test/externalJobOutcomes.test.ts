import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import {
  MAX_SCHEDULING_HINT_SECONDS,
  pollVerdict,
  recoveryVerdict,
  startVerdict,
  type CallResult,
} from "../src/core/externalJobs/outcomes.js";
import { nextRunDelaySeconds } from "../src/core/externalJobs/scheduling.js";
import {
  DEFAULT_WORKER_SETTINGS,
  validateWorkerSettings,
  workerSettingsFromConfig,
} from "../src/core/externalJobs/settings.js";

const returned = (value: unknown): CallResult => ({ kind: "returned", value });
const settings = { ...DEFAULT_WORKER_SETTINGS, jitterRatio: 0 };

describe("external-job call outcomes are the typed error boundary", () => {
  it("treats every throw, timeout or invalid start return as ambiguous", () => {
    expect(startVerdict({ kind: "threw" })).toEqual({ kind: "ambiguous", issue: { code: "adapter_fault", retryAfterSeconds: null } });
    expect(startVerdict({ kind: "timeout" })).toEqual({ kind: "ambiguous", issue: { code: "timeout", retryAfterSeconds: null } });
    for (const value of [
      null, "accepted", [], { kind: "accepted" }, { kind: "accepted", job: [] },
      { kind: "accepted", job: {}, pollAfterSeconds: MAX_SCHEDULING_HINT_SECONDS + 1 },
      { kind: "accepted", job: {}, pollAfterSeconds: 1.5 }, { kind: "terminal" },
      { kind: "ambiguous" }, { kind: "ambiguous", issue: { code: "timeout", detail: "x" } },
      { kind: "safe-to-start", basis: "authoritative-absence" }, { kind: "pending" },
    ]) {
      expect(startVerdict(returned(value)), JSON.stringify(value)).toEqual({
        kind: "ambiguous", issue: { code: "invalid_response", retryAfterSeconds: null },
      });
    }
    expect(startVerdict(returned({ kind: "accepted", job: { jobId: "j" }, pollAfterSeconds: 30 })))
      .toEqual({ kind: "accepted", job: { jobId: "j" }, pollAfterSeconds: 30 });
    expect(startVerdict(returned({ kind: "ambiguous", issue: { code: "rate_limited", retryAfterSeconds: 9 } })))
      .toEqual({ kind: "ambiguous", issue: { code: "rate_limited", retryAfterSeconds: 9 } });
    // A terminal value is judged against the admitted contract later.
    expect(startVerdict(returned({ kind: "terminal", result: { status: "completed" } })))
      .toEqual({ kind: "terminal", result: { status: "completed" } });
  });

  it("treats a recovery throw or invalid return as unknown, never as permission to start", () => {
    expect(recoveryVerdict({ kind: "threw" })).toMatchObject({ kind: "unknown", issue: { code: "adapter_fault" } });
    for (const value of [
      { kind: "safe-to-start" }, { kind: "safe-to-start", basis: "empty-search" },
      { kind: "safe-to-start", basis: "idempotent-replay", because: "x" }, { kind: "unknown", issue: { code: "x" } },
      { kind: "ambiguous", issue: { code: "timeout" } },
    ]) {
      expect(recoveryVerdict(returned(value)), JSON.stringify(value)).toMatchObject({
        kind: "unknown", issue: { code: "invalid_response" },
      });
    }
    expect(recoveryVerdict(returned({ kind: "safe-to-start", basis: "idempotent-replay" })))
      .toEqual({ kind: "safe-to-start", basis: "idempotent-replay" });
    expect(recoveryVerdict(returned({ kind: "unknown", retryAfterSeconds: 600 })))
      .toEqual({ kind: "unknown", issue: null, retryAfterSeconds: 600 });
  });

  it("treats a poll throw or invalid return as a retry, never as product failure", () => {
    expect(pollVerdict({ kind: "threw" })).toEqual({ kind: "retry", issue: { code: "adapter_fault", retryAfterSeconds: null } });
    expect(pollVerdict(returned({ kind: "failed" }))).toMatchObject({ kind: "retry", issue: { code: "invalid_response" } });
    expect(pollVerdict(returned({ kind: "pending" }))).toEqual({ kind: "pending", pollAfterSeconds: null });
    expect(pollVerdict(returned({ kind: "retry", issue: { code: "upstream_unavailable" } })))
      .toEqual({ kind: "retry", issue: { code: "upstream_unavailable", retryAfterSeconds: null } });
  });
});

describe("external-job scheduling", () => {
  const delay = (kind: "pending" | "failure", failures = 1, overdue = false, hint: number | null = null, random = 0.5) =>
    nextRunDelaySeconds({ kind, failures, overdue, hintSeconds: hint, settings, random: () => random });

  it("polls pending jobs at the interval and backs failures off exponentially to a bound", () => {
    expect(delay("pending")).toBe(60);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((failures) => delay("failure", failures)))
      .toEqual([15, 30, 60, 120, 240, 480, 960, 1_800, 1_800]);
    expect(delay("failure", 1_000)).toBe(1_800);
  });

  it("keeps the overdue cadence and never undercuts a product's minimum delay", () => {
    expect(delay("pending", 0, true)).toBe(300);
    expect(delay("failure", 1, true)).toBe(300);
    expect(delay("pending", 0, false, 5_000)).toBe(5_000);
    expect(delay("pending", 0, true, 7_200)).toBe(7_200);
    expect(delay("failure", 1, false, 90)).toBe(90);
  });

  it("spreads core's own delays by the jitter ratio only", () => {
    const jittered = { ...DEFAULT_WORKER_SETTINGS };
    const at = (random: number, hint: number | null = null) => nextRunDelaySeconds({
      kind: "pending", failures: 0, overdue: false, hintSeconds: hint, settings: jittered, random: () => random,
    });
    expect([at(0), at(0.5), at(1)]).toEqual([54, 60, 66]);
    expect(at(0, 100)).toBe(100);
  });
});

describe("external-job worker settings", () => {
  it("defaults to a 30-second call, a 90-second lease renewed every 20 seconds, four calls and a 60-second poll", () => {
    expect(validateWorkerSettings({ ...DEFAULT_WORKER_SETTINGS })).toMatchObject({
      callTimeoutMs: 30_000, leaseSeconds: 90, leaseRenewMs: 20_000, maxConcurrentCalls: 4,
      pollIntervalSeconds: 60, overduePollSeconds: 300,
    });
  });

  it("refuses a lease that a call and two renewals, or three renewals, would outlive", () => {
    expect(() => validateWorkerSettings({ ...DEFAULT_WORKER_SETTINGS, leaseRenewMs: 40_000 })).toThrow(/three/);
    expect(() => validateWorkerSettings({ ...DEFAULT_WORKER_SETTINGS, callTimeoutMs: 60_000 })).toThrow(/call plus/);
    expect(() => validateWorkerSettings({ ...DEFAULT_WORKER_SETTINGS, maxConcurrentCalls: 0 })).toThrow(/range/);
    expect(() => validateWorkerSettings({ ...DEFAULT_WORKER_SETTINGS, jitterRatio: 1 })).toThrow(/range/);
  });

  it("parses the configured settings strictly", () => {
    const base = {
      BASE_URL: "https://provider.example", GATEWAY_BASE_URL: "https://gateway.example", PROVIDER_NAME: "Example",
      MARKETPLACE_TERMS_URL: "https://daski.example/terms", MARKETPLACE_PRIVACY_URL: "https://daski.example/privacy",
      PROVIDER_TERMS_URL: "https://provider.example/terms", PROVIDER_PRIVACY_URL: "https://provider.example/privacy",
      SUPPORT_EMAIL: "support@provider.example", DATABASE_URL: "postgresql://runtime:secret@db.example/provider",
      CHAIN_ID: "84532", BASE_RPC_URL: "https://rpc.example", PROVIDER_WALLET_PRIVATE_KEY: `0x${"44".repeat(32)}`,
      PROVIDER_AGENT_ID: "1", IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      RATE_LIMIT_HASH_KEY: "a-secure-rate-limit-key-1234567890-ABCDEFG",
    };
    expect(workerSettingsFromConfig(parseConfig(base))).toEqual(DEFAULT_WORKER_SETTINGS);
    expect(workerSettingsFromConfig(parseConfig({
      ...base, EXTERNAL_JOB_CALL_TIMEOUT_MS: "10000", EXTERNAL_JOB_MAX_CONCURRENT_CALLS: "8",
    }))).toMatchObject({ callTimeoutMs: 10_000, maxConcurrentCalls: 8 });
    for (const invalid of [
      { EXTERNAL_JOB_LEASE_SECONDS: "30" }, { EXTERNAL_JOB_MAX_CONCURRENT_CALLS: "0" },
      { EXTERNAL_JOB_POLL_INTERVAL_SECONDS: "1" }, { EXTERNAL_JOB_CALL_TIMEOUT_MS: "abc" },
    ]) expect(() => parseConfig({ ...base, ...invalid }), JSON.stringify(invalid)).toThrow(/EXTERNAL_JOB/);
  });
});
