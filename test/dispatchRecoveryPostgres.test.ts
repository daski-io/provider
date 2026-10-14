import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_recovery_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { config } from "../src/core/config.js";
import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import {
  acceptDispatchSnapshotAsGateway,
  classifyDispatchAnswer,
  classifyStatusAnswer,
  gatewayQuoteRequest,
  gatewayStatusQuery,
  nowSeconds,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { gatewayListing } from "./standardRailServiceFixture.js";

describePostgres("dispatch recovery and fresh observations against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_recovery", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
    rail = await startRailHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await rail?.close();
    // Bounded: a request left hanging by a failed test must not skip the drop.
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  const admitted = async (harness = rail) => {
    const order = await quoteOrder({ quotes: harness.quotes, outcome: harness.outcome });
    const dispatched = await dispatchOrder({ order, outcome: harness.outcome, config: harness.config });
    const answer = await harness.post("/standard-rail/dispatch", dispatched.body);
    return { order, ...dispatched, answer };
  };

  /** Let the claim's COMMIT reach the server, then lose its acknowledgement once. */
  const loseNextCommitAck = (afterLoss: () => void = () => undefined) => {
    const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<PoolClient>;
    let armed = true;
    // Pool.query borrows clients through connect(callback); pass that through.
    vi.spyOn(pool, "connect").mockImplementation(((callback?: unknown) => callback
      ? connect(callback)
      : wrap()) as never);
    const wrap = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let claimInserted = false;
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        const sql = String(args[0]);
        if (sql.includes("INSERT INTO provider_transactions")) claimInserted = true;
        const result = await query(...args);
        if (armed && claimInserted && sql === "COMMIT") {
          armed = false;
          afterLoss();
          throw new Error("Connection terminated unexpectedly");
        }
        return result;
      };
      return client;
    };
  };

  it("keeps the revision and stamps a fresh observation on unchanged orders read long after", async () => {
    const completed = await admitted();
    const first = await acceptDispatchSnapshotAsGateway({
      value: json(completed.answer), dispatchHash: completed.dispatchHash,
    });
    // Age the order as if it completed eight hours ago. Only this test setup
    // may move a terminal identity, so it lifts the freeze for one statement.
    await pool.query("ALTER TABLE provider_transactions DISABLE TRIGGER provider_transactions_terminal_identity");
    await pool.query(
      `UPDATE provider_transactions SET created_at=created_at - interval '8 hours',
         completed_at=completed_at - interval '8 hours' WHERE order_id=$1`,
      [completed.order.orderId],
    );
    await pool.query("ALTER TABLE provider_transactions ENABLE TRIGGER provider_transactions_terminal_identity");
    await pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,created_at,
         execution_owner,execution_lease_token,execution_lease_expires_at
       ) VALUES ('task-pending','https://gateway.example','ord_00000000-0000-4000-8000-0000000000aa',
         decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),decode(repeat('33',32),'hex'),
         '0x1111111111111111111111111111111111111111','dummy','echo',decode(repeat('44',32),'hex'),
         'executing',now() + interval '5 minutes',now() - interval '6 minutes',
         gen_random_uuid(),gen_random_uuid(),now() + interval '1 hour')`,
    );
    const pendingHash = `0x${"cd".repeat(32)}` as Hex;
    for (const [orderId, dispatchHash, state] of [
      [completed.order.orderId, completed.dispatchHash, "completed"],
      ["ord_00000000-0000-4000-8000-0000000000aa", pendingHash, "working"],
    ] as const) {
      const reads = [];
      for (let index = 0; index < 2; index += 1) {
        reads.push(await acceptDispatchSnapshotAsGateway({
          value: json(await rail.status(orderId, dispatchHash)), dispatchHash,
        }));
      }
      for (const read of reads) {
        expect(read.body.state).toBe(state);
        expect(read.operations.revision).toBe(0);
        expect(Math.abs(read.operations.observedAt - nowSeconds())).toBeLessThanOrEqual(5);
      }
      expect(reads[1]!.operations.observedAt).toBeGreaterThanOrEqual(reads[0]!.operations.observedAt);
      if (state === "completed") {
        expect(reads[0]!.attestation).toEqual(reads[1]!.attestation);
        expect(reads[0]!.attestation!.resultHash).toBe(first.attestation!.resultHash);
        expect(reads[0]!.attestation!.completedAt).toBe(first.attestation!.completedAt - 8 * 3_600);
      }
    }
    await expect(pool.query(
      `UPDATE provider_transactions SET operations_projection=
         '{"fulfillment":null,"recovery":null,"support":{"reviewId":"r"}}' WHERE id='task-pending'`,
    )).rejects.toThrow("operations revision must identify exactly one projection");
  });

  it("answers a lost request with the reviewed no-claim 404 only after authoritative absence", async () => {
    const never = `ord_${globalThis.crypto.randomUUID()}`;
    const answer = await rail.status(never, `0x${"42".repeat(32)}`);
    expect([answer.status, json(answer)])
      .toEqual([404, { error: "dispatch_status_unavailable", reason: "outcome_policy" }]);
    expect(classifyStatusAnswer(answer)).toBe("no_claim");
  });

  it("recovers a lost dispatch response through status without a second execution", async () => {
    const lost = await admitted();
    const executions = rail.executions;
    const recovered = await rail.status(lost.order.orderId, lost.dispatchHash);
    expect(classifyStatusAnswer(recovered)).toBe("snapshot");
    const read = await acceptDispatchSnapshotAsGateway({
      value: json(recovered), dispatchHash: lost.dispatchHash,
    });
    expect(read.body.taskId).toBe(json(lost.answer).taskId);
    expect(rail.executions).toBe(executions);
  });

  it("continues after a lost commit acknowledgement once the claim is proven durable", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body, dispatchHash } = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    loseNextCommitAck();
    const answer = await rail.post("/standard-rail/dispatch", body);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
  });

  it("resolves a lost commit acknowledgement on a later bounded re-read", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body, dispatchHash } = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let failures = 0;
    let lost = false;
    loseNextCommitAck(() => { lost = true; });
    vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      if (lost && failures === 0 && String(args[0]).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
        failures += 1;
        throw new Error("Connection terminated unexpectedly");
      }
      return query(...args);
    }) as never);
    const answer = await rail.post("/standard-rail/dispatch", body);
    expect(failures).toBe(1);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
  });

  it("answers ambiguously when a lost commit acknowledgement cannot be resolved", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body, dispatchHash } = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let lookupDown = false;
    loseNextCommitAck(() => { lookupDown = true; });
    vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      if (lookupDown && String(args[0]).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
        throw new Error("Connection terminated unexpectedly");
      }
      return query(...args);
    }) as never);
    const executions = rail.executions;
    const answer = await rail.post("/standard-rail/dispatch", body);
    lookupDown = false;
    expect([answer.status, answer.text, answer.contentType]).toEqual([503, "", null]);
    expect(classifyDispatchAnswer(answer)).toBe("ambiguous");
    vi.restoreAllMocks();
    const status = await rail.status(order.orderId, dispatchHash);
    expect(classifyStatusAnswer(status)).toBe("snapshot");
    expect(json(status).state).toBe("working");
    expect(rail.executions).toBe(executions);
  });

  it("answers signing failures ambiguously and never as absence", async () => {
    const broken = await startRailHarness({
      signer: {
        authority: async () => { throw new Error("signer unavailable"); },
        terminal: async () => { throw new Error("signer unavailable"); },
      },
    });
    try {
      const { order, answer, dispatchHash } = await admitted(broken);
      expect([answer.status, answer.text]).toEqual([503, ""]);
      const status = await broken.status(order.orderId, dispatchHash);
      expect([status.status, status.text]).toEqual([503, ""]);
      expect(classifyStatusAnswer(status)).toBe("unavailable");
    } finally {
      await broken.close();
      await rail.close();
      rail = await startRailHarness();
    }
  });

  it("never claims absence for a forged, stale, cross-type, misaddressed or unreadable query", async () => {
    const { order, dispatchHash } = await admitted();
    const now = nowSeconds();
    const valid = await gatewayStatusQuery(order.orderId, dispatchHash);
    const listing = gatewayListing(rail.outcome);
    const cases: unknown[] = [
      { ...valid, signature: `0x${"11".repeat(65)}` },
      await gatewayStatusQuery(order.orderId, dispatchHash, now - 120),
      await signGatewayEnvelope({ ...valid, audience: "https://elsewhere.example", privateKey: undefined }),
      await gatewayQuoteRequest({ listing, request: { message: "x" }, payer: null }),
      await signGatewayEnvelope({
        artifactType: "DispatchStatusQueryV1", issuedAt: now, validBefore: now + 60,
        payload: { orderId: order.orderId, dispatchHash, issuedAt: now, validBefore: now + 61 },
      }),
    ];
    for (const query of cases) {
      const answer = await rail.post("/standard-rail/dispatch/status", { query });
      expect(classifyStatusAnswer(answer)).toBe("unavailable");
      expect(answer.text).not.toContain("outcome_policy");
    }
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).includes("FROM provider_transactions")) throw new Error("database unavailable");
      return query(...args);
    }) as never);
    const unreadable = await rail.status(`ord_${globalThis.crypto.randomUUID()}`, dispatchHash);
    expect([unreadable.status, unreadable.text]).toEqual([503, ""]);
  });

  it("serves 2,880 signed status reads without product calls, purchase limits or writes", async () => {
    const { order, dispatchHash } = await admitted();
    const readiness = vi.spyOn(rail.service, "readiness");
    const executions = rail.executions;
    const statements: string[] = [];
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      statements.push(String(args[0]).trim());
      return query(...args);
    }) as never);
    const connect = vi.spyOn(pool, "connect");
    const before = await query(
      "SELECT count(*)::int AS buckets FROM rate_limit_buckets",
    ) as { rows: Array<{ buckets: number }> };
    // Eight concurrent pollers; each signed query is reused within its 60 s window.
    for (let batch = 0; batch < 2_880 / 480; batch += 1) {
      const query = { query: await gatewayStatusQuery(order.orderId, dispatchHash) };
      const answers = await Promise.all(Array.from({ length: 8 }, async () => {
        const seen = [];
        for (let read = 0; read < 60; read += 1) {
          seen.push(await rail.post("/standard-rail/dispatch/status", query));
        }
        return seen;
      }));
      const flat = answers.flat();
      expect(flat.every((answer) => answer.status === 200)).toBe(true);
      await acceptDispatchSnapshotAsGateway({ value: json(flat.at(-1)!), dispatchHash });
    }
    const after = await query(
      "SELECT count(*)::int AS buckets FROM rate_limit_buckets",
    ) as { rows: Array<{ buckets: number }> };
    expect(rail.executions).toBe(executions);
    expect(readiness).not.toHaveBeenCalled();
    // Only Pool.query's internal checkout (with a callback); no transaction.
    expect(connect.mock.calls.filter((args) => (args as unknown[]).length === 0)).toHaveLength(0);
    // One indexed claim read per status answer, plus the abuse guard's
    // read-only bucket lookup; nothing is written for a verified read.
    expect(statements.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
    expect(statements.filter((sql) => sql.includes("FROM provider_transactions"))).toHaveLength(2_880);
    expect(statements.filter((sql) => sql.includes("FROM rate_limit_buckets"))).toHaveLength(2_880);
    expect(after.rows[0]!.buckets).toBe(before.rows[0]!.buckets);
    const forged = await rail.post("/standard-rail/dispatch/status", {
      query: { ...(await gatewayStatusQuery(order.orderId, dispatchHash)), signature: `0x${"11".repeat(65)}` },
    });
    expect(forged.status).toBe(401);
    const oversized = await rail.post("/standard-rail/dispatch/status", JSON.stringify({
      query: await gatewayStatusQuery(order.orderId, dispatchHash),
      padding: "x".repeat(70_000),
    }));
    expect(oversized.status).toBe(413);
  }, 60_000);

  // Runs last: it exhausts the loopback source's shared failure bucket.
  it("limits sources of unauthenticated servicing failures without charging verified reads", async () => {
    const { order, dispatchHash } = await admitted();
    const valid = { query: await gatewayStatusQuery(order.orderId, dispatchHash) };
    for (let read = 0; read < 150; read += 1) {
      expect((await rail.post("/standard-rail/dispatch/status", valid)).status).toBe(200);
    }
    const forged = { query: { ...valid.query, signature: `0x${"11".repeat(65)}` } };
    let refused = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const answer = await rail.post("/standard-rail/dispatch/status", forged);
      if (answer.status === 429) break;
      expect(answer.status).toBe(401);
      refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(120);
    const blocked = await rail.post("/standard-rail/dispatch/status", valid);
    expect([blocked.status, json(blocked).error]).toEqual([429, "rate_limit_exceeded"]);
    expect(classifyStatusAnswer(blocked)).toBe("unavailable");
    const dispatch = await rail.post("/standard-rail/dispatch", {});
    expect(classifyDispatchAnswer(dispatch)).toBe("refused");
    const saved = config.RATE_LIMIT_BYPASS_IPS;
    Object.assign(config, { RATE_LIMIT_BYPASS_IPS: "127.0.0.1" });
    const bypassed = await startRailHarness();
    try {
      const answer = await bypassed.status(order.orderId, dispatchHash);
      expect(classifyStatusAnswer(answer)).toBe("snapshot");
    } finally {
      Object.assign(config, { RATE_LIMIT_BYPASS_IPS: saved });
      await bypassed.close();
    }
  }, 60_000);
});
