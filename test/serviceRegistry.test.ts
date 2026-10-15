import { beforeEach, describe, expect, it } from "vitest";
import { externalJobAdapterVersions } from "../src/core/serviceRegistry/adapterValidation.js";
import {
  minimumExternalJobFulfillmentSeconds,
  minimumSynchronousFulfillmentSeconds,
  skillDeadlines,
} from "../src/core/serviceRegistry/deadlines.js";
import {
  clearServicesForTests,
  getAdapter,
  getAdmittingAdapter,
  getAllServices,
  getExternalJobAdapter,
  getSkill,
  getSyncAdapter,
  registerService,
} from "../src/core/serviceRegistry/registry.js";
import type { ExternalJobAdapter, ServiceModule } from "../src/core/serviceRegistry/types.js";
import { dummyService } from "../src/services/dummy/index.js";

const jobAdapter = (version: string, extra: Partial<ExternalJobAdapter> = {}): ExternalJobAdapter => ({
  mode: "external-job",
  version,
  start: async () => ({ kind: "ambiguous", issue: { code: "timeout" } }),
  recoverStart: async () => ({ kind: "unknown" }),
  poll: async () => ({ kind: "pending" }),
  ...extra,
});

/** The dummy's shape with an external-job adapter and a declared job window. */
const jobService = (overrides: Partial<ServiceModule> = {}): ServiceModule => ({
  ...dummyService,
  adapter: jobAdapter("v2"),
  skills: [{ ...dummyService.skills[0]!, deadlines: { fulfillmentSeconds: 43_200 } }],
  ...overrides,
});

describe("minimal service registry", () => {
  beforeEach(clearServicesForTests);

  it("registers a documented fixed-price service in memory", () => {
    registerService(dummyService);
    expect(getAllServices()).toEqual([dummyService]);
    expect(getSkill("dummy", "echo")?.fixedPriceAtomic).toBe("10000");
    expect(getAdapter("dummy")).toBe(dummyService.adapter);
  });

  it("rejects duplicate services, invalid prices, and missing docs", () => {
    registerService(dummyService);
    expect(() => registerService(dummyService)).toThrow(/already registered/);
    clearServicesForTests();
    expect(() => registerService({
      ...dummyService,
      skills: [{ ...dummyService.skills[0]!, fixedPriceAtomic: "0" }],
    })).toThrow(/positive fixed/);
    expect(() => registerService({
      ...dummyService,
      docs: { service: "", skills: dummyService.docs.skills },
    })).toThrow(/missing service documentation/);
  });

  it("refuses a synchronous window too short to recover a lost dispatch", () => {
    const withDeadlines = (deadlines: { dispatchSeconds?: number; fulfillmentSeconds?: number }) => ({
      ...dummyService,
      skills: [{ ...dummyService.skills[0]!, deadlines }],
    });
    // dispatchSeconds + 60 s no-claim grace + 50 s budget + 120 s reviewed margin.
    expect(minimumSynchronousFulfillmentSeconds(300)).toBe(530);
    for (const deadlines of [
      { dispatchSeconds: 300, fulfillmentSeconds: 50 },
      { dispatchSeconds: 300, fulfillmentSeconds: 529 },
      { dispatchSeconds: 600, fulfillmentSeconds: 829 },
      { dispatchSeconds: 700 },
      { dispatchSeconds: 29, fulfillmentSeconds: 900 },
      { dispatchSeconds: 300, fulfillmentSeconds: 31_536_001 },
      { dispatchSeconds: 300.5, fulfillmentSeconds: 900 },
    ]) {
      clearServicesForTests();
      expect(() => registerService(withDeadlines(deadlines)), JSON.stringify(deadlines)).toThrow();
    }
    for (const deadlines of [
      { dispatchSeconds: 300, fulfillmentSeconds: 530 },
      { dispatchSeconds: 600, fulfillmentSeconds: 830 },
      { fulfillmentSeconds: 530 },
      {},
    ]) {
      clearServicesForTests();
      expect(() => registerService(withDeadlines(deadlines))).not.toThrow();
    }
    expect(skillDeadlines({})).toEqual({ dispatchSeconds: 300, fulfillmentSeconds: 900 });
  });

  // L01/L02/L07: one reviewed mode per service; external jobs declare their
  // window; retained versions are keyed by exactly their own version.
  it("registers an external-job service and resolves the adapter of a persisted version", () => {
    const v1 = jobAdapter("v1", { idempotencyRetentionSeconds: 86_400 });
    registerService(jobService({ previousExternalJobAdapters: { v1 } }));
    const module = getAllServices()[0]!;
    expect(getAdapter("dummy").mode).toBe("external-job");
    expect(getExternalJobAdapter("dummy", "v2")).toBe(module.adapter);
    expect(getExternalJobAdapter("dummy", "v1")).toBe(v1);
    expect(getExternalJobAdapter("dummy", "v3")).toBeNull();
    expect(getExternalJobAdapter("dummy", "constructor")).toBeNull();
    expect(getExternalJobAdapter("other", "v2")).toBeNull();
    expect(externalJobAdapterVersions(module)).toEqual(["v2", "v1"]);
    expect(() => getSyncAdapter("dummy")).toThrow(/not synchronous/);
    clearServicesForTests();
    // A service whose new sales moved back to the synchronous mode still
    // resumes the jobs its earlier version admitted.
    registerService({ ...dummyService, previousExternalJobAdapters: { v1 } });
    expect(getSyncAdapter("dummy")).toBe(dummyService.adapter);
    expect(getExternalJobAdapter("dummy", "v1")).toBe(v1);
  });

  // A funded order is admitted under the adapter version that sold its quote.
  it("selects the adapter that sold a quote, or the current one for a quote that recorded none", () => {
    const v1 = jobAdapter("v1");
    registerService(jobService({ previousExternalJobAdapters: { v1 } }));
    const current = getAllServices()[0]!.adapter;
    expect(getAdmittingAdapter("dummy", "v1")).toBe(v1);
    expect(getAdmittingAdapter("dummy", "v2")).toBe(current);
    // Sold by a synchronous adapter, or recorded before versions were: today's adapter.
    expect(getAdmittingAdapter("dummy", null)).toBe(current);
    // A version this build lacks admits nothing, never the current adapter in its place.
    expect(getAdmittingAdapter("dummy", "v0")).toBeNull();
    expect(getAdmittingAdapter("dummy", "__proto__")).toBeNull();
    expect(getAdmittingAdapter("other", null)).toBeNull();
    clearServicesForTests();
    // New sales moved to the synchronous mode: an order sold by v1 still runs as v1's job.
    registerService({ ...dummyService, previousExternalJobAdapters: { v1 } });
    expect(getAdmittingAdapter("dummy", "v1")).toBe(v1);
    expect(getAdmittingAdapter("dummy", null)).toBe(dummyService.adapter);
  });

  it("refuses an adapter outside the reviewed modes or an ambiguous version set", () => {
    const refused = (module: ServiceModule, pattern: RegExp) => {
      clearServicesForTests();
      expect(() => registerService(module)).toThrow(pattern);
    };
    refused({ ...dummyService, adapter: { mode: "async" } as never }, /external-job adapter/);
    refused({ ...dummyService, adapter: { mode: "sync" } as never }, /must implement execute/);
    refused(jobService({ adapter: jobAdapter("") }), /needs a version/);
    refused(jobService({ adapter: jobAdapter("v 2") }), /needs a version/);
    refused(jobService({ adapter: { ...jobAdapter("v2"), poll: undefined } as never }), /implement poll/);
    for (const retention of [0, 1.5, 31_536_001, -1]) {
      refused(jobService({ adapter: jobAdapter("v2", { idempotencyRetentionSeconds: retention }) }),
        /idempotencyRetentionSeconds/);
    }
    refused(jobService({ previousExternalJobAdapters: { v1: jobAdapter("v0") } }), /keyed by another version/);
    refused(jobService({ previousExternalJobAdapters: { v2: jobAdapter("v2") } }), /repeats the current/);
    refused(jobService({ previousExternalJobAdapters: [] as never }), /must be a record/);
  });

  it("requires an external-job skill to declare a window that survives a lost dispatch", () => {
    expect(minimumExternalJobFulfillmentSeconds(300)).toBe(480);
    const withDeadlines = (deadlines: { dispatchSeconds?: number; fulfillmentSeconds?: number }) =>
      jobService({ skills: [{ ...dummyService.skills[0]!, deadlines }] });
    for (const deadlines of [{}, { dispatchSeconds: 300 }, { fulfillmentSeconds: 479 }, { fulfillmentSeconds: 31_536_001 }]) {
      clearServicesForTests();
      expect(() => registerService(withDeadlines(deadlines)), JSON.stringify(deadlines)).toThrow();
    }
    clearServicesForTests();
    expect(() => registerService(withDeadlines({ fulfillmentSeconds: 480 }))).not.toThrow();
  });
});
