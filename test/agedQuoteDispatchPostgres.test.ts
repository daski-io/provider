import { afterAll, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_aged_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, migrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { loadListingObligations, verifyRetainedObligations } from "../src/core/standardRail/retainedObligations.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder, type GatewayOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

/** This suite's build serves no external-job service and holds no job key. */
const NO_EXTERNAL_JOBS = { adapterVersions: () => new Set<string>(), keyIds: new Set<string>(), canSeal: false };
const DAY_MS = 86_400_000;

// C04: the gateway's first dispatch of a timely-paid order may come at any
// time after its first release observation, which nothing bounds relative
// to the quote. Until a verified gateway inventory exists, no quote retires.
describePostgres("quotes long past any guessed dispatch window, against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_aged", undefined, target.name);
    await runMigrations();
    rail = await startRailHarness();
  });

  afterAll(async () => {
    await rail?.close();
    await closeMigrationPool();
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("keeps a 61-day-old quote's obligations and admits its order's first dispatch", async () => {
    expect(rail.outcome.fulfillmentSeconds).toBe(900);
    // Two quotes for a 900-second outcome, paid on time 61 days ago.
    const issued = Date.now() - 61 * DAY_MS;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => issued);
    const orders: GatewayOrder[] = [];
    try {
      for (const message of ["first", "second"]) {
        orders.push(await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, request: { message } }));
      }
    } finally {
      clock.mockRestore();
    }
    const owed = (await loadListingObligations(pool, rail.config.gatewayAudience, rail.config))
      .get(rail.outcome.listingManifestHash);
    expect(owed).toMatchObject({ claims: 0, openQuotes: 2 });
    await expect(verifyRetainedObligations(pool, rail.config, NO_EXTERNAL_JOBS)).resolves.toBeUndefined();
    // Not even the schema owner, who ran boot's housekeeping, can drop one.
    for (const order of orders) {
      await expect(migrationPool.query(
        "DELETE FROM provider_quotes WHERE quote_hash=$1", [Buffer.from(order.providerQuoteHash.slice(2), "hex")],
      )).rejects.toThrow("a provider quote is retained while a dispatch may still name it");
    }
    // First dispatches now, with fresh envelopes and the deposits' timely evidence.
    for (const order of orders) {
      const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
      await expect(acceptDispatchSnapshotAsGateway({
        value: json(await rail.post("/standard-rail/dispatch", dispatched.body)), dispatchHash: dispatched.dispatchHash,
      })).resolves.toMatchObject({ body: { state: "completed" } });
    }
    expect(rail.executions).toBe(2);
    expect((await loadListingObligations(pool, rail.config.gatewayAudience, rail.config))
      .get(rail.outcome.listingManifestHash)).toMatchObject({ claims: 2, openQuotes: 2 });
  });
});
