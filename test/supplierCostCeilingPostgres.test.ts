import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_ceiling_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import {
  checkSupplierSpend,
  SUPPLIER_COST_CEILING_EXCEEDED,
  type ServiceResult,
  type SupplierCostCeiling,
  type TaskContext,
} from "../src/core/serviceRegistry/types.js";
import { StandardQuoteService } from "../src/core/standardRail/quote.js";
import { loadProviderQuote } from "../src/core/standardRail/quoteStore.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

/** The supplier's price when the order was quoted: 4.25 USD, so at most 4.675 at the default 10%. */
const supplierCost = { supplier: "example", currency: "USD", amount: "4.25" };
const ceiling: SupplierCostCeiling = {
  kind: "supplier-cost-ceiling-v2", supplier: "example", currency: "USD", quotedAmount: "4.25", tolerancePercent: "10",
};
const refused: ServiceResult = { status: "failed", errorCode: SUPPLIER_COST_CEILING_EXCEEDED };
/** The test adapters spend the amount the buyer's message names, only within the order's ceiling. */
const spends = (context: TaskContext, input: Record<string, unknown>) =>
  checkSupplierSpend(context.supplierCostCeiling, { ...supplierCost, amount: String(input.message) }).ok;

// Supplier price tolerance (spec A, lite): the price a service reports at
// quote time is recorded with the quote, with the tolerance in force, and
// bounds what the order's adapter may spend, in either mode.
describePostgres("supplier-cost ceilings against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness | null = null;
  let jobs: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_ceiling", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await rail?.close();
    await jobs?.close();
    rail = null;
    jobs = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("records the reported price with the tolerance in force when the quote is issued", async () => {
    rail = await startRailHarness({ service: { requestReadiness: async () => ({ ready: true, supplierCost }) } });
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    await expect(loadProviderQuote(order.providerQuoteHash)).resolves.toMatchObject({ supplierCostCeiling: ceiling });
    // A later tolerance governs later quotes only; a recorded ceiling never changes.
    const tighter = new StandardQuoteService(rail.config, 84532, { supplierPriceTolerancePercent: "2.5" });
    const later = await quoteOrder({ quotes: tighter, outcome: rail.outcome, request: { message: "later" } });
    await expect(loadProviderQuote(later.providerQuoteHash))
      .resolves.toMatchObject({ supplierCostCeiling: { ...ceiling, tolerancePercent: "2.5" } });
    await expect(pool.query(
      "UPDATE provider_quotes SET supplier_cost_ceiling=NULL WHERE quote_hash=$1",
      [Buffer.from(order.providerQuoteHash.slice(2), "hex")],
    )).rejects.toThrow("a provider quote keeps the supplier-cost ceiling it was issued with");
    await expect(loadProviderQuote(order.providerQuoteHash)).resolves.toMatchObject({ supplierCostCeiling: ceiling });
  });

  it("gives a synchronous execution its order's ceiling and attests a refused spend as-is", async () => {
    const seen: TaskContext[] = [];
    rail = await startRailHarness({
      service: {
        requestReadiness: async () => ({ ready: true, supplierCost }),
        adapter: {
          execute: async (context, input) => {
            seen.push(context);
            return spends(context, input)
              ? {
                status: "completed",
                message: "Echo completed.",
                artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: input.message } }],
              }
              : refused;
          },
        },
      },
    });
    for (const [amount, state] of [["4.675", "completed"], ["4.676", "failed"]] as const) {
      const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, request: { message: amount } });
      const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
      const answer = await acceptDispatchSnapshotAsGateway({
        value: json(await rail.post("/standard-rail/dispatch", dispatched.body)), dispatchHash: dispatched.dispatchHash,
      });
      expect(answer.body.state, amount).toBe(state);
      const claim = await pool.query("SELECT result FROM provider_transactions WHERE order_id=$1", [order.orderId]);
      // The code is core's own: attested although the service lists no failure codes.
      if (state === "failed") expect(claim.rows).toEqual([{ result: refused }]);
    }
    expect(seen.map((context) => context.supplierCostCeiling)).toEqual([ceiling, ceiling]);
  });

  it("gives every external-job call its order's ceiling, null when the quote recorded none", async () => {
    let report = true;
    jobs = await startJobHarness({
      service: { requestReadiness: async () => (report ? { ready: true, supplierCost } : { ready: true }) },
    });
    const harness = jobs;
    harness.adapter.onStart = async (context, input) => spends(context, input)
      ? { kind: "accepted", job: { jobId: `up-${String(input.message)}` } }
      : { kind: "terminal", result: refused };
    const within = await harness.admit({ message: "4.675" });
    const above = await harness.admit({ message: "4.676" });
    report = false;
    const unbounded = await harness.admit({ message: "0" });
    expect(await harness.round()).toBe(3);
    await harness.due(within.taskId);
    expect(await harness.round()).toBe(1);
    const ceilings = harness.adapter.calls.map((call) => [call.method, call.context.taskId, call.context.supplierCostCeiling]);
    expect(ceilings).toEqual(expect.arrayContaining([
      ["start", within.taskId, ceiling], ["poll", within.taskId, ceiling],
      ["start", above.taskId, ceiling], ["start", unbounded.taskId, null],
    ]));
    expect(ceilings).toHaveLength(4);
    expect((await harness.job(within.taskId)).phase).toBe("polling");
    // Without a ceiling no spend is allowed; both refusals are attested as-is.
    for (const job of [above, unbounded]) {
      expect(await harness.claim(job.taskId)).toMatchObject({ state: "failed", result: refused });
    }
  });
});
