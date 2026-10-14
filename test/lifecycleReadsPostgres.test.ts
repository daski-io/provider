import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_lifecycle_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { canonicalHash, canonicalJson } from "../src/core/standardRail/canonical.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import {
  acceptLifecycleAnswerAsGateway,
  gatewayLifecycleCall,
  LIFECYCLE_HEADERS,
  payerAuthorization,
  type StoredTerminal,
} from "./gatewayLifecycleWire.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";

const payerKey = `0x${"5a".repeat(32)}` as Hex;
const payer = privateKeyToAccount(payerKey).address;

describePostgres("lifecycle reads against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_lifecycle", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
    rail = await startRailHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await rail?.close();
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  /** A paid order dispatched and finished through the real handlers. */
  async function finished(harness = rail) {
    const order = await quoteOrder({ quotes: harness.quotes, outcome: harness.outcome, payer });
    const dispatched = await dispatchOrder({ order, outcome: harness.outcome, config: harness.config });
    const answer = await harness.post("/standard-rail/dispatch", dispatched.body);
    const accepted = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: dispatched.dispatchHash });
    const terminal = accepted.attestation!;
    const stored: StoredTerminal = {
      taskId: terminal.taskId, state: terminal.state, resultHash: terminal.resultHash, completedAt: terminal.completedAt,
    };
    return { orderId: order.orderId, taskId: accepted.body.taskId as string, stored };
  }

  const call = async (
    orderId: string,
    taskId: string,
    action: string,
    access: "read" | "signed",
    request: Record<string, unknown> = {},
  ) => gatewayLifecycleCall({
    orderId, providerTaskId: taskId, action, payer, request,
    ...(access === "signed"
      ? { authorization: await payerAuthorization({ payerKey, orderId, action, request }) }
      : {}),
  });

  const read = async (harness: RailHarness, body: unknown) =>
    harness.post("/standard-rail/lifecycle", body, LIFECYCLE_HEADERS);

  it("serves one frozen terminal identity and artifact across reads, both forms and a restart", async () => {
    const { orderId, taskId, stored } = await finished();
    const attestations: unknown[] = [];
    const artifacts: string[] = [];
    const judge = async (harness: RailHarness, action: "status" | "artifact", access: "read" | "signed") => {
      const answer = await read(harness, await call(orderId, taskId, action, access));
      const accepted = await acceptLifecycleAnswerAsGateway({
        value: json(answer), action, orderId, providerTaskId: taskId,
        resultSchema: echoResultSchema(), storedTerminal: stored,
      });
      attestations.push(accepted.body.terminalAttestation);
      if (action === "artifact") {
        expect(canonicalHash(accepted.body.result)).toBe(stored.resultHash);
        artifacts.push(canonicalJson(accepted.body.result));
      }
    };
    for (const access of ["read", "signed"] as const) {
      await judge(rail, "status", access);
      await judge(rail, "status", access);
      await judge(rail, "artifact", access);
    }
    await rail.close();
    rail = await startRailHarness();
    await judge(rail, "status", "read");
    await judge(rail, "artifact", "signed");
    expect(new Set(attestations.map((value) => JSON.stringify(value))).size).toBe(1);
    expect(new Set(artifacts).size).toBe(1);
    const row = (await pool.query("SELECT result FROM provider_transactions WHERE id=$1", [taskId])).rows[0];
    expect(artifacts[0]).toBe(canonicalJson(row.result));
  });

  it("answers unsupported mutations without touching the task or the product (L-T13)", async () => {
    const { orderId, taskId } = await finished();
    const before = (await pool.query("SELECT * FROM provider_transactions WHERE id=$1", [taskId])).rows[0];
    const executions = rail.executions;
    for (const [action, request] of [
      ["cancel", {}],
      ["input", { inputText: "Change it.", data: { message: "other" } }],
      ["support", { requestId: "support-1", message: "Please help." }],
    ] as const) {
      const answer = await read(rail, await call(orderId, taskId, action, "signed", request));
      expect([answer.status, answer.text]).toEqual([409, '{"error":"unsupported_action"}']);
    }
    const after = (await pool.query("SELECT * FROM provider_transactions WHERE id=$1", [taskId])).rows[0];
    expect(after).toEqual(before);
    expect(rail.executions).toBe(executions);
  });

  it("attests failure evidence on status and refuses its artifact", async () => {
    const failing = await startRailHarness({
      service: { adapter: { execute: async () => ({
        status: "failed", errorCode: "account_7_locked", message: "Upstream said account 7 is locked.",
      }) } },
    });
    try {
      const { orderId, taskId, stored } = await finished(failing);
      const evidence = { status: "failed", errorCode: "service_execution_failed" };
      expect(stored).toMatchObject({ state: "failed", resultHash: canonicalHash(evidence) });
      const status = await acceptLifecycleAnswerAsGateway({
        value: json(await read(failing, await call(orderId, taskId, "status", "read"))),
        action: "status", orderId, providerTaskId: taskId, resultSchema: echoResultSchema(), storedTerminal: stored,
      });
      expect(status.body.state).toBe("failed");
      const artifact = await read(failing, await call(orderId, taskId, "artifact", "read"));
      expect([artifact.status, artifact.text]).toEqual([409, '{"error":"artifact_unavailable"}']);
    } finally {
      await failing.close();
      await rail.close();
      rail = await startRailHarness();
    }
  });

  it("serves 600 signed lifecycle reads without product calls, purchase limits or writes", async () => {
    const { orderId, taskId } = await finished();
    const readiness = vi.spyOn(rail.service, "readiness");
    const executions = rail.executions;
    const statements: string[] = [];
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      statements.push(String(args[0]).trim());
      return query(...args);
    }) as never);
    const before = await query("SELECT count(*)::int AS buckets FROM rate_limit_buckets") as {
      rows: Array<{ buckets: number }>;
    };
    for (let batch = 0; batch < 5; batch += 1) {
      // One grant per batch, reused within its 120-second validity.
      const body = await call(orderId, taskId, batch % 2 ? "artifact" : "status", "read");
      const answers = await Promise.all(Array.from({ length: 4 }, async () => {
        const seen = [];
        for (let index = 0; index < 30; index += 1) seen.push(await read(rail, body));
        return seen;
      }));
      expect(answers.flat().every((answer) => answer.status === 200)).toBe(true);
    }
    const after = await query("SELECT count(*)::int AS buckets FROM rate_limit_buckets") as {
      rows: Array<{ buckets: number }>;
    };
    expect(rail.executions).toBe(executions);
    expect(readiness).not.toHaveBeenCalled();
    expect(statements.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
    expect(statements.filter((sql) => sql.includes("FROM provider_transactions"))).toHaveLength(600);
    expect(after.rows[0]!.buckets).toBe(before.rows[0]!.buckets);
  }, 60_000);

  // Runs last: it exhausts the loopback source's lifecycle failure bucket.
  it("keeps lifecycle failures out of the budget paid dispatches depend on", async () => {
    const { orderId, taskId } = await finished();
    const dispatched = await finished();
    // Buyer content the gateway forwards under a valid grant charges nothing.
    for (let index = 0; index < 150; index += 1) {
      const answer = await read(rail, await call(orderId, taskId, "status", "read", { x: "y".repeat(40_000) }));
      expect(answer.status).toBe(400);
    }
    expect((await read(rail, await call(orderId, taskId, "status", "read"))).status).toBe(200);
    // Forged grants are unauthenticated: they exhaust lifecycle's own bucket only.
    const forged = { ...(await call(orderId, taskId, "status", "read")) };
    forged.grant = { ...forged.grant, signature: `0x${"11".repeat(64)}1b` as Hex };
    let refused = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const answer = await read(rail, forged);
      if (answer.status === 503) break;
      expect(answer.status).toBe(401);
      refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(120);
    const blocked = await read(rail, await call(orderId, taskId, "status", "read"));
    expect([blocked.status, blocked.text]).toEqual([503, '{"error":"lifecycle_unavailable"}']);
    const status = await rail.status(dispatched.orderId, `0x${(await pool.query(
      "SELECT encode(dispatch_hash,'hex') AS hash FROM provider_transactions WHERE order_id=$1",
      [dispatched.orderId],
    )).rows[0].hash}` as Hex);
    expect(status.status).toBe(200);
  }, 60_000);
});
