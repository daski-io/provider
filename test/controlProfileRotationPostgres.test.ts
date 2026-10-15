import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_profile_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { verifyRetainedObligations } from "../src/core/standardRail/retainedObligations.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

/** This suite's builds serve no external-job service and hold no job key. */
const NO_EXTERNAL_JOBS = { adapterVersions: () => new Set<string>(), keyIds: new Set<string>(), canSeal: false };
// The provider's control profile before it changed.
const previousProfile = `0x${"d1".repeat(32)}` as Hex;
const REFUSED = { error: "dispatch_rejected", reason: "outcome_policy" };

// C04: the gateway dispatches an order with the control profile its checkout
// snapshot committed, so a profile change must not strand an order quoted
// and paid before it.
describePostgres("a provider control-profile change against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_profile", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await rail?.close();
    rail = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("serves an order quoted under the previous profile only while that profile is retained", async () => {
    const before = await startRailHarness({ outcome: { providerControlProfileHash: previousProfile } });
    const control = await quoteOrder({ quotes: before.quotes, outcome: before.outcome });
    const pending = await quoteOrder({ quotes: before.quotes, outcome: before.outcome });
    const first = await dispatchOrder({ order: control, outcome: before.outcome, config: before.config });
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(await before.post("/standard-rail/dispatch", first.body)), dispatchHash: first.dispatchHash,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    await before.close();
    // `before.outcome` is what the gateway's checkout snapshot of the pending
    // order still holds: the same listing version under the previous profile.

    // Only the profile changed: listing, route, audience and keys stay.
    rail = await startRailHarness();
    expect(rail.outcome.listingManifestHash).toBe(before.outcome.listingManifestHash);
    expect(rail.config.providerControlProfileHash).not.toBe(previousProfile);
    const refused = await rail.post(
      "/standard-rail/dispatch",
      (await dispatchOrder({ order: pending, outcome: before.outcome, config: rail.config })).body,
    );
    expect([refused.status, json(refused)]).toEqual([409, REFUSED]);
    expect(rail.executions).toBe(0);
    // Boot, the importer and the doctor name the profile its quotes still need.
    await expect(verifyRetainedObligations(pool, rail.config, NO_EXTERNAL_JOBS))
      .rejects.toThrow(/\(control profile 0xd1d1d1d1…d1d1 not retained\)/);
    await rail.close();

    rail = await startRailHarness({ retained: { controlProfiles: [previousProfile] } });
    await expect(verifyRetainedObligations(pool, rail.config, NO_EXTERNAL_JOBS)).resolves.toBeUndefined();
    // The gateway's next envelope for the same paid order is admitted.
    const retried = await dispatchOrder({ order: pending, outcome: before.outcome, config: rail.config });
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(await rail.post("/standard-rail/dispatch", retried.body)), dispatchHash: retried.dispatchHash,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    expect(rail.executions).toBe(1);
    // A profile this deployment never retained stays refused.
    const stranger = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const unknown = await rail.post("/standard-rail/dispatch", (await dispatchOrder({
      order: stranger, outcome: { ...rail.outcome, providerControlProfileHash: `0x${"d2".repeat(32)}` }, config: rail.config,
    })).body);
    expect([unknown.status, json(unknown)]).toEqual([409, REFUSED]);
    expect(rail.executions).toBe(1);
  });
});
