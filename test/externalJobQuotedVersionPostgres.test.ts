import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_quoted_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { externalJobServicing } from "../src/core/externalJobs/servicing.js";
import { clearServicesForTests, getAllServices, registerService } from "../src/core/serviceRegistry/registry.js";
import type { ServiceModule, ServiceResult } from "../src/core/serviceRegistry/types.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { FIXED_QUOTE_LIFETIME_SECONDS, StandardQuoteService } from "../src/core/standardRail/quote.js";
import { persistProviderQuote } from "../src/core/standardRail/quoteStore.js";
import { assertObligationsServiceable, loadListingObligations } from "../src/core/standardRail/retainedObligations.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { json } from "./dispatchHarness.js";
import { echoCompleted, jobPayer, startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { jobKeys, jobRuntime, jobService, scriptedAdapter, type ScriptedAdapter } from "./externalJobFixture.js";
import { parseFieldEncryptionKeys } from "../src/core/security/fieldEncryption.js";
import { dispatchOrder, quoteOrder, type GatewayOrder } from "./gatewayOrderFixture.js";
import { nowSeconds, providerKey } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { railConfig, railOutcome } from "./standardRailServiceFixture.js";

const randomHash = () => `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}` as Hex;
/** Versions unique to one test, so no other test's unfinished job is ever claimed. */
const versions = () => {
  const id = randomUUID().slice(0, 8);
  return [`v1-${id}`, `v2-${id}`] as const;
};

/** What the new adapter version's report maps to: valid for the head, not for the old version. */
const report: ServiceResult = {
  status: "completed",
  artifacts: [{ name: "report", mimeType: "application/json", data: { findings: 2 } }],
};
const reportSchema = (): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["status", "artifacts"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    artifacts: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "data"],
        properties: {
          name: { type: "string", enum: ["report"] },
          mimeType: { type: "string", enum: ["application/json"] },
          data: {
            type: "object",
            additionalProperties: false,
            required: ["findings"],
            properties: { findings: { type: "integer", minimum: 0 } },
          },
        },
      },
    },
  },
});

/** The superseded listing version: it was sold with the echo result contract. */
const superseded = (): ProviderOutcomeConfig => railOutcome({ listingManifestHash: randomHash(), maxOpenOrders: 1_000 });

/** v1 reads only its own references and reports the echo result. */
function v1Adapter(version: string): ScriptedAdapter {
  const adapter = scriptedAdapter(version);
  adapter.onStart = async () => ({ kind: "accepted", job: { v1Ticket: "t-1" } });
  adapter.onPoll = async (_context, job) => (job.v1Ticket === "t-1"
    ? { kind: "terminal", result: echoCompleted }
    : { kind: "retry", issue: { code: "invalid_response" } });
  return adapter;
}

/** v2 changed the reference format and maps reports to the head's contract. */
function useV2(adapter: ScriptedAdapter): void {
  adapter.onStart = async () => ({ kind: "accepted", job: { v2Handle: { id: "h-2" } } });
  adapter.onPoll = async (_context, job) => (job.v2Handle
    ? { kind: "terminal", result: report }
    : { kind: "retry", issue: { code: "invalid_response" } });
}

// An external-job order is run by the adapter version that sold its quote,
// even when it is first dispatched after an upgrade moved new sales to
// another version: the version is recorded with the quote, selected at
// admission, and held as an obligation while the quote may be dispatched.
describePostgres("external-job orders run by the adapter version that sold them", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_quoted", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  /** The upgraded build: the head sells with v2 and the superseded version is still serviced. */
  const upgraded = async (v2: string, old: ProviderOutcomeConfig, service: Partial<ServiceModule> = {}) => {
    h = await startJobHarness({
      version: v2,
      outcome: { listingManifestHash: randomHash(), resultSchema: reportSchema() },
      retained: { versions: [old] },
      service,
    });
    useV2(h.adapter);
    return h;
  };

  /** A quote the previous build issued while it sold `listing` with `adapter`. */
  async function soldBefore(
    listing: ProviderOutcomeConfig, adapter: ScriptedAdapter, request: Record<string, unknown>,
  ): Promise<GatewayOrder> {
    const installed = getAllServices();
    clearServicesForTests();
    registerService(jobService(adapter));
    try {
      const quotes = new StandardQuoteService(railConfig([listing]), 84532, { externalJobs: jobRuntime(jobKeys()) });
      return await quoteOrder({ quotes, outcome: listing, payer: jobPayer, request });
    } finally {
      clearServicesForTests();
      for (const service of installed) registerService(service);
    }
  }

  /** A quote persisted without a version, as a build before migration 010 recorded every quote. */
  async function unrecorded(listing: ProviderOutcomeConfig, request: Record<string, unknown>): Promise<GatewayOrder> {
    const issuedAt = nowSeconds();
    const payload = {
      outcomeId: listing.outcomeId,
      listingManifestHash: listing.listingManifestHash,
      requestHash: canonicalHash(request),
      grossAmount: listing.fixedGrossAmount,
      payer: jobPayer.toLowerCase() as Hex,
      issuedAt,
      validBefore: issuedAt + FIXED_QUOTE_LIFETIME_SECONDS,
    };
    const quoteHash = await persistProviderQuote(payload, {
      adapterVersion: null, controlProfileHash: listing.providerControlProfileHash, supplierCostCeiling: null,
    });
    const signature = await privateKeyToAccount(providerKey).signMessage({ message: { raw: quoteHash } });
    const quotes = { quote: async () => ({ ...payload, signature }) } as unknown as StandardQuoteService;
    return quoteOrder({ quotes, outcome: listing, payer: jobPayer, request });
  }

  const dispatch = async (harness: JobHarness, order: GatewayOrder, listing: ProviderOutcomeConfig) => {
    const dispatched = await dispatchOrder({ order, outcome: listing, config: harness.rail.config });
    return harness.rail.post("/standard-rail/dispatch", dispatched.body);
  };

  /** Start the job, then make its first poll due and run it. */
  const runToPoll = async (harness: JobHarness, taskId: string) => {
    await harness.round();
    await harness.due(taskId);
    await harness.round();
  };

  it("runs an order sold before an upgrade with the version that sold it, against its own contract", async () => {
    const [v1Version, v2Version] = versions();
    const v1 = v1Adapter(v1Version);
    const old = superseded();
    const harness = await upgraded(v2Version, old, { previousExternalJobAdapters: { [v1Version]: v1 } });
    const order = await soldBefore(old, v1, { message: "sold before the upgrade" });
    const quoted = await pool.query<{ adapter_version: string | null }>(
      "SELECT adapter_version FROM provider_quotes WHERE quote_hash=$1",
      [Buffer.from(order.providerQuoteHash.slice(2), "hex")],
    );
    expect(quoted.rows).toEqual([{ adapter_version: v1Version }]);
    // First dispatched after the upgrade: still v1's order, never v2's.
    const answer = json(await dispatch(harness, order, old));
    expect(answer.state).toBe("submitted");
    const taskId = String(answer.taskId);
    expect((await harness.job(taskId)).adapter_version).toBe(v1Version);
    await runToPoll(harness, taskId);
    expect(await harness.claim(taskId)).toMatchObject({ state: "completed", result: echoCompleted });
    expect(v1.calls.map((call) => [call.method, call.context.taskId])).toEqual([["start", taskId], ["poll", taskId]]);
    expect(harness.adapter.calls).toEqual([]);
    expect((await harness.job(taskId)).result_diagnostic).toBeNull();
    // New sales of the head record v2 and run with it against the head's contract.
    const fresh = await harness.admit({ message: "sold after the upgrade" });
    expect((await harness.job(fresh.taskId)).adapter_version).toBe(v2Version);
    await runToPoll(harness, fresh.taskId);
    expect(await harness.claim(fresh.taskId)).toMatchObject({ state: "completed", result: report });
    expect(harness.adapter.calls.map((call) => call.context.taskId)).toEqual([fresh.taskId, fresh.taskId]);
  });

  it("admits a quote that recorded no version under the service's current adapter", async () => {
    const [, v2Version] = versions();
    const old = superseded();
    const harness = await upgraded(v2Version, old);
    const order = await unrecorded(old, { message: "recorded before migration 010" });
    const answer = json(await dispatch(harness, order, old));
    expect(answer.state).toBe("submitted");
    expect((await harness.job(String(answer.taskId))).adapter_version).toBe(v2Version);
  });

  it("refuses an order whose selling version this build dropped, and refuses to take it over", async () => {
    const [v1Version, v2Version] = versions();
    const v1 = v1Adapter(v1Version);
    const old = superseded();
    const harness = await upgraded(v2Version, old);
    const order = await soldBefore(old, v1, { message: "dropped version" });
    // Never run with v2 in its place: a definite refusal before any claim.
    const refused = await dispatch(harness, order, old);
    expect([refused.status, json(refused)]).toEqual([409, { error: "dispatch_rejected", reason: "outcome_policy" }]);
    const claims = async () => (await pool.query("SELECT id FROM provider_transactions WHERE order_id=$1", [order.orderId])).rows;
    expect(await claims()).toEqual([]);
    expect([v1.calls, harness.adapter.calls]).toEqual([[], []]);
    // Boot, the importer and activation hold the open quote to its version
    // (the same check, scoped to this test's listing version).
    const config = harness.rail.config;
    const takeover = async (services: ServiceModule[]) => {
      const all = await loadListingObligations(pool, config.gatewayAudience, config);
      assertObligationsServiceable({
        catalog: config,
        obligations: new Map([...all].filter(([hash]) => hash === old.listingManifestHash)),
        signingWallets: new Set([config.terminalAttestationKey]),
        externalJobs: externalJobServicing(services, jobKeys()),
        controlProfiles: new Set([config.providerControlProfileHash]),
      });
    };
    await expect(takeover([harness.rail.service]))
      .rejects.toThrow(`(external-job adapter dummy@${v1Version} not installed)`);
    const retaining = jobService(harness.adapter, { previousExternalJobAdapters: { [v1Version]: v1 } });
    await expect(takeover([retaining])).resolves.toBeUndefined();
    // A build that retains v1 admits the gateway's next fresh envelope as v1's job.
    clearServicesForTests();
    registerService(retaining);
    const admitted = json(await dispatch(harness, order, old));
    const taskId = String(admitted.taskId);
    expect([admitted.state, (await harness.job(taskId)).adapter_version]).toEqual(["submitted", v1Version]);
    await runToPoll(harness, taskId);
    expect(await harness.claim(taskId)).toMatchObject({ state: "completed", result: echoCompleted });
    // Its job finished, yet the quote still needs v1: only the gateway could
    // prove no other dispatch will name it (an identical request quoted in
    // the same second shares the quote).
    await expect(takeover([harness.rail.service]))
      .rejects.toThrow(`(external-job adapter dummy@${v1Version} not installed)`);
  });

  it("refuses to take over open external-job quotes without an active key to admit their orders", async () => {
    const [v1Version, v2Version] = versions();
    const v1 = v1Adapter(v1Version);
    const old = superseded();
    const harness = await upgraded(v2Version, old, { previousExternalJobAdapters: { [v1Version]: v1 } });
    await soldBefore(old, v1, { message: "needs a key at admission" });
    // A quote that recorded no version (a synchronous sale, or one from before 010).
    const unversioned = superseded();
    await unrecorded(unversioned, { message: "no version recorded" });
    const catalog = railConfig([harness.rail.outcome], { versions: [old, unversioned] });
    const takeover = async (listing: ProviderOutcomeConfig, keys: ReturnType<typeof jobKeys>) => {
      const all = await loadListingObligations(pool, catalog.gatewayAudience, catalog);
      assertObligationsServiceable({
        catalog,
        obligations: new Map([...all].filter(([hash]) => hash === listing.listingManifestHash)),
        signingWallets: new Set([catalog.terminalAttestationKey]),
        externalJobs: externalJobServicing([harness.rail.service], keys),
        controlProfiles: new Set([catalog.providerControlProfileHash]),
      });
    };
    // Previous keys alone open stored state but cannot seal a new order's input.
    const readOnly = parseFieldEncryptionKeys({ activeKeyId: "primary", previousKeys: `k1=0x${"a1".repeat(32)}` });
    await expect(takeover(old, readOnly))
      .rejects.toThrow("(no active encryption key to admit the orders of open external-job quotes)");
    await expect(takeover(old, jobKeys())).resolves.toBeUndefined();
    await expect(takeover(unversioned, readOnly)).resolves.toBeUndefined();
  });

  it("attests a retained version's failure with its code while the module's list keeps it", async () => {
    const [v1Version, v2Version] = versions();
    const v1 = v1Adapter(v1Version);
    v1.onPoll = async () => ({
      kind: "terminal", result: { status: "failed", errorCode: "audit_rejected", message: "free text is dropped" },
    });
    const old = superseded();
    // v2 renamed its failure to audit_declined; v1's code stays listed while v1 is installed.
    const harness = await upgraded(v2Version, old, {
      previousExternalJobAdapters: { [v1Version]: v1 }, failureCodes: ["audit_declined", "audit_rejected"],
    });
    const run = async (message: string) => {
      const order = await soldBefore(old, v1, { message });
      const taskId = String(json(await dispatch(harness, order, old)).taskId);
      await runToPoll(harness, taskId);
      return (await harness.claim(taskId)).result as unknown;
    };
    await expect(run("listed")).resolves.toEqual({ status: "failed", errorCode: "audit_rejected" });
    // One list judges every version's results: dropping the code loses it.
    clearServicesForTests();
    registerService(jobService(harness.adapter, {
      previousExternalJobAdapters: { [v1Version]: v1 }, failureCodes: ["audit_declined"],
    }));
    await expect(run("dropped")).resolves.toEqual({ status: "failed", errorCode: "service_execution_failed" });
  });
});
