import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_terminal_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, failInterruptedTransactions, pool, runMigrations } from "../src/core/db/pool.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

const MIGRATIONS = new URL("../src/core/db/migrations/", import.meta.url);
const bytes = (hex: Hex) => Buffer.from(hex.slice(2), "hex");
const frozen = (value: unknown) => bytes(canonicalHash(value));

const LEGACY = {
  completed: {
    id: "task-legacy-completed",
    orderId: "ord_00000000-0000-4000-8000-0000000000c1",
    dispatchHash: `0x${"c1".repeat(32)}` as Hex,
    state: "completed",
    // Stored exactly as the pre-R1 image wrote it; its key order is not canonical.
    result: { status: "completed", artifacts: [{ data: { message: "old" }, name: "echo_result" }],
      message: "Echo completed." },
  },
  failed: {
    id: "task-legacy-failed",
    orderId: "ord_00000000-0000-4000-8000-0000000000c2",
    dispatchHash: `0x${"c2".repeat(32)}` as Hex,
    state: "failed",
    result: { status: "failed", errorCode: "invalid_input",
      message: "The message must contain 1 to 500 Unicode code points." },
  },
  interrupted: {
    id: "task-legacy-executing",
    orderId: "ord_00000000-0000-4000-8000-0000000000c3",
    dispatchHash: `0x${"c3".repeat(32)}` as Hex,
    state: "executing",
    result: null,
  },
} as const;

describePostgres("frozen terminal identity against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  /** The pre-R1 image: only the baseline migration, its own claim and completion writes. */
  async function seedLegacyImage(): Promise<void> {
    await pool.query(`CREATE TABLE _migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const baseline = readFileSync(new URL("001_initial.sql", MIGRATIONS), "utf8");
    await pool.query(baseline);
    await pool.query("INSERT INTO _migrations (name, checksum) VALUES ($1,$2)", [
      "001_initial.sql", createHash("sha256").update(baseline).digest("hex"),
    ]);
    for (const [index, row] of Object.values(LEGACY).entries()) {
      await pool.query(
        `INSERT INTO provider_transactions (
           id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
           service_slug,skill_id,listing_manifest_hash,state
         ) VALUES ($1,'https://gateway.example',$2,$3,$4,decode(repeat('33',32),'hex'),
           '0x1111111111111111111111111111111111111111','dummy','echo',
           decode(repeat('44',32),'hex'),'executing')`,
        [row.id, row.orderId, Buffer.alloc(32, index + 1), bytes(row.dispatchHash)],
      );
      if (row.result) {
        await pool.query(
          `UPDATE provider_transactions SET state=$2,result=$3::jsonb,completed_at=now()
            WHERE id=$1 AND state='executing'`,
          [row.id, row.state, JSON.stringify(row.result)],
        );
      }
    }
  }

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_terminal", undefined, target.name);
    await seedLegacyImage();
    await runMigrations();
    await closeMigrationPool();
    rail = await startRailHarness();
  });

  afterAll(async () => {
    await rail?.close();
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  const stored = async (id: string) => (await pool.query(
    "SELECT state,result::text AS text,result,result_hash,completed_at FROM provider_transactions WHERE id=$1",
    [id],
  )).rows[0] as { state: string; text: string; result: unknown; result_hash: Buffer | null; completed_at: Date };

  const attestation = async (harness: RailHarness, orderId: string, dispatchHash: Hex) =>
    (await acceptDispatchSnapshotAsGateway({
      value: json(await harness.status(orderId, dispatchHash)), dispatchHash,
    })).body.terminalAttestation;

  it("preserves legacy terminal rows and attests them from their stored bytes", async () => {
    for (const row of [LEGACY.completed, LEGACY.failed]) {
      const before = await stored(row.id);
      expect(before.result_hash).toBeNull();
      expect(before.result).toEqual(row.result);
      const attested = await attestation(rail, row.orderId, row.dispatchHash);
      expect(attested?.payload).toMatchObject({
        state: row.state,
        resultHash: canonicalHash(row.result),
        completedAt: Math.floor(before.completed_at.getTime() / 1_000),
      });
      expect(await stored(row.id)).toEqual(before);
    }
    await expect(pool.query(
      "UPDATE provider_transactions SET result=$2::jsonb WHERE id=$1",
      [LEGACY.failed.id, JSON.stringify({ status: "failed", errorCode: "invalid_input" })],
    )).rejects.toThrow("a terminal task identity is frozen");
  });

  it("freezes the hash when the startup sweep fails an interrupted legacy execution", async () => {
    await expect(failInterruptedTransactions()).resolves.toBe(1);
    const evidence = { status: "failed", errorCode: "provider_restarted_during_execution" };
    expect(await stored(LEGACY.interrupted.id)).toMatchObject({
      state: "failed",
      result: evidence,
      result_hash: frozen(evidence),
    });
  });

  it("freezes a new result with its hash and serves one identity across reads and restarts", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const answer = await rail.post("/standard-rail/dispatch", dispatched.body);
    const first = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: dispatched.dispatchHash });
    const row = (await pool.query(
      "SELECT id,result,result_hash,completed_at FROM provider_transactions WHERE order_id=$1",
      [order.orderId],
    )).rows[0] as { id: string; result: unknown; result_hash: Buffer; completed_at: Date };
    expect(row.result_hash).toEqual(frozen(row.result));
    expect(first.attestation).toEqual({
      taskId: row.id,
      dispatchHash: dispatched.dispatchHash,
      state: "completed",
      resultHash: canonicalHash(row.result),
      completedAt: Math.floor(row.completed_at.getTime() / 1_000),
    });
    const reads = [];
    for (let index = 0; index < 3; index += 1) {
      reads.push(await attestation(rail, order.orderId, dispatched.dispatchHash));
    }
    await rail.close();
    rail = await startRailHarness();
    reads.push(await attestation(rail, order.orderId, dispatched.dispatchHash));
    for (const read of reads) expect(read).toEqual(json(answer).terminalAttestation);
    for (const change of [
      ["result", JSON.stringify({ status: "completed", message: "Changed." })],
      ["result_hash", frozen({ other: true })],
      ["completed_at", new Date(0)],
      ["state", "failed"],
      ["payer", "0x2222222222222222222222222222222222222222"],
    ] as const) {
      await expect(pool.query(
        `UPDATE provider_transactions SET ${change[0]}=$2 WHERE id=$1`,
        [row.id, change[1]],
      ), change[0]).rejects.toThrow(/frozen|keeps its bindings/);
    }
  });

  it("refuses a terminal transition that does not freeze its hash", async () => {
    await pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before
       ) VALUES ('task-unhashed','https://gateway.example','ord_00000000-0000-4000-8000-0000000000c4',
         decode(repeat('c4',32),'hex'),decode(repeat('c4',32),'hex'),decode(repeat('33',32),'hex'),
         '0x1111111111111111111111111111111111111111','dummy','echo',decode(repeat('44',32),'hex'),
         'executing',now() + interval '5 minutes')`,
    );
    await expect(pool.query(
      `UPDATE provider_transactions SET state='completed',result='{"status":"completed"}',
         completed_at=now() WHERE id='task-unhashed'`,
    )).rejects.toThrow("a terminal transition must freeze its result hash");
    await expect(pool.query(
      "UPDATE provider_transactions SET result_hash=$1 WHERE id='task-unhashed'",
      [frozen({ status: "completed" })],
    )).rejects.toThrow("provider_transactions_pending_unhashed");
  });
});
