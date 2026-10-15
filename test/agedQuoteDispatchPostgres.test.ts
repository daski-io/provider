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
import { MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS } from "../src/core/standardRail/dispatchContract.js";
import { loadProviderQuote, pruneRetiredQuotes } from "../src/core/standardRail/quoteStore.js";
import { loadListingObligations, verifyRetainedObligations } from "../src/core/standardRail/retainedObligations.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder, type GatewayOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway, nowSeconds } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

/** This suite's build serves no external-job service and holds no job key. */
const NO_EXTERNAL_JOBS = { adapterVersions: () => new Set<string>(), keyIds: new Set<string>(), canSeal: false };
const DAY_SECONDS = 86_400;
const REFUSED = { error: "dispatch_rejected", reason: "quote_window" };

// B2/B3: the gateway never makes a first dispatch more than 30 days after a
// quote's QuoteV1 expired. A new claim from a later dispatch is refused, and
// a quote stays an obligation only until its own validBefore plus 31 days.
describePostgres("quotes against the first-dispatch bound, against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  /** A quote and its gateway QuoteV1, issued (and paid on time) at `issuedAt`. */
  async function quotedAt(issuedAt: number, message: string): Promise<GatewayOrder> {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => issuedAt * 1_000);
    try {
      return await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, request: { message } });
    } finally {
      clock.mockRestore();
    }
  }

  const dispatch = async (order: GatewayOrder, issuedAt?: number) => {
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config, issuedAt });
    return { dispatched, answer: await rail.post("/standard-rail/dispatch", dispatched.body) };
  };
  const owed = async () => (await loadListingObligations(pool, rail.config.gatewayAudience, rail.config))
    .get(rail.outcome.listingManifestHash);
  const deleteQuote = (order: GatewayOrder) => migrationPool.query(
    "DELETE FROM provider_quotes WHERE quote_hash=$1", [Buffer.from(order.providerQuoteHash.slice(2), "hex")],
  );

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

  it("refuses a 61-day-old quote's first dispatch, owes nothing for it and prunes it", async () => {
    const aged = await quotedAt(nowSeconds() - 61 * DAY_SECONDS, "aged");
    // Its listing version owes nothing for it: no definition, adapter version
    // or control profile is needed to boot, import or activate.
    expect(await owed()).toBeUndefined();
    await expect(verifyRetainedObligations(pool, rail.config, NO_EXTERNAL_JOBS)).resolves.toBeUndefined();
    // A definite refusal before any claim: nothing runs, nothing is admitted.
    const { answer } = await dispatch(aged);
    expect([answer.status, json(answer)]).toEqual([409, REFUSED]);
    expect(rail.executions).toBe(0);
    expect((await pool.query("SELECT 1 FROM provider_transactions WHERE order_id=$1", [aged.orderId])).rows)
      .toEqual([]);
    // Boot's housekeeping, as the schema owner, deletes it.
    await expect(pruneRetiredQuotes(migrationPool)).resolves.toBe(1);
    await expect(loadProviderQuote(aged.providerQuoteHash)).resolves.toBeNull();
  });

  it("admits and owes a 20-day-old quote's first dispatch", async () => {
    const recent = await quotedAt(nowSeconds() - 20 * DAY_SECONDS, "recent");
    expect(await owed()).toMatchObject({ claims: 0, openQuotes: 1 });
    // Not even the schema owner, who runs boot's housekeeping, can drop it.
    await expect(deleteQuote(recent)).rejects.toThrow("a provider quote is retained while a dispatch may still name it");
    await expect(pruneRetiredQuotes(migrationPool)).resolves.toBe(0);
    const { dispatched, answer } = await dispatch(recent);
    await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: dispatched.dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
    expect(rail.executions).toBe(1);
    expect(await owed()).toMatchObject({ claims: 1, openQuotes: 1 });
  });

  it("admits a dispatch issued exactly at the bound, refuses one a second later, and replays the admitted one", async () => {
    // Each QuoteV1 expires 120 seconds after it is issued, so a quote issued
    // here reaches the bound now.
    const issuedAt = nowSeconds() - 120 - MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS;
    const [atBound, past] = [await quotedAt(issuedAt, "at the bound"), await quotedAt(issuedAt, "past it")];
    expect(atBound.quote.payload.validBefore).toBe(issuedAt + 120);
    const bound = atBound.quote.payload.validBefore + MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS;
    const late = await dispatch(past, bound + 1);
    expect([late.answer.status, json(late.answer)]).toEqual([409, REFUSED]);
    const timely = await dispatch(atBound, bound);
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(timely.answer), dispatchHash: timely.dispatched.dispatchHash,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    // The admitted claim's exact replay and status are answered whatever its quote's age.
    const replay = await rail.post("/standard-rail/dispatch", timely.dispatched.body);
    expect([replay.status, json(replay).state]).toEqual([200, "completed"]);
    const status = await rail.status(atBound.orderId, timely.dispatched.dispatchHash);
    expect([status.status, json(status).state]).toEqual([200, "completed"]);
  });
});
