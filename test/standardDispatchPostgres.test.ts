import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_dispatch_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { QuoteV1, SignedEnvelope } from "../src/core/standardRail/types.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import {
  acceptDispatchSnapshotAsGateway,
  classifyDispatchAnswer,
  classifyStatusAnswer,
  gatewayQuoteRequest,
  nowSeconds,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { gatewayListing } from "./standardRailServiceFixture.js";

const claims = async (orderId: string) => (await pool.query(
  "SELECT id FROM provider_transactions WHERE order_id=$1", [orderId],
)).rowCount;

async function resignQuote(quote: SignedEnvelope<QuoteV1>, patch: Partial<QuoteV1>) {
  const payload = { ...quote.payload, ...patch };
  return signGatewayEnvelope<QuoteV1>({
    artifactType: "QuoteV1",
    audience: "https://gateway.example",
    signerKeyId: "gateway-quote",
    issuedAt: payload.issuedAt,
    validBefore: payload.validBefore,
    payload,
  });
}

describePostgres("funded dispatch admission against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_dispatch", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
    rail = await startRailHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    rail.state.ready = true;
  });

  afterAll(async () => {
    await rail?.close();
    await pool.end().catch(() => undefined);
    await database?.drop();
  });

  const admit = async (order: Awaited<ReturnType<typeof quoteOrder>>) => {
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    return { ...dispatched, answer: await rail.post("/standard-rail/dispatch", dispatched.body) };
  };

  it("admits a dispatch bound to its persisted readiness quote and answers the gateway contract", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { answer, dispatchHash, envelope } = await admit(order);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    const accepted = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash });
    expect(accepted.body.state).toBe("completed");
    expect(accepted.operations.revision).toBe(0);
    expect(json(answer)).not.toHaveProperty("result");
    const row = (await pool.query(
      `SELECT result,extract(epoch FROM dispatch_valid_before)::bigint AS valid_before,
              operations_revision FROM provider_transactions WHERE order_id=$1`,
      [order.orderId],
    )).rows[0];
    expect(accepted.attestation?.resultHash).toBe(canonicalHash(row.result));
    expect(Number(row.valid_before)).toBe(envelope.validBefore);
    expect(row.operations_revision).toBe(0);
  });

  it("accepts a fresh dispatch long after quote expiry when the payment settled in time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 30 * 86_400_000);
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    vi.useRealTimers();
    expect(order.quote.validBefore).toBeLessThan(nowSeconds() - 29 * 86_400);
    const { answer, dispatchHash } = await admit(order);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
  });

  it("refuses late payment, expired envelopes and binding conflicts before any admission", async () => {
    const refused = async (body: Record<string, unknown>, reason: string, orderId: string) => {
      const answer = await rail.post("/standard-rail/dispatch", body);
      expect(classifyDispatchAnswer(answer)).toBe("refused");
      expect(json(answer)).toEqual({ error: "dispatch_rejected", reason });
      expect(await claims(orderId)).toBe(0);
    };
    const late = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    rail.evidence.depositTimestamps.set(late.orderId, late.quote.validBefore + 1);
    await refused((await dispatchOrder({ order: late, outcome: rail.outcome, config: rail.config })).body,
      "evidence", late.orderId);

    const expired = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    await refused((await dispatchOrder({
      order: expired, outcome: rail.outcome, config: rail.config, issuedAt: nowSeconds() - 301,
    })).body, "envelope_lifetime", expired.orderId);

    const otherPayer = await quoteOrder({
      quotes: rail.quotes, outcome: rail.outcome, quotePayer: `0x${"12".repeat(20)}` as Hex,
    });
    await refused((await dispatchOrder({ order: otherPayer, outcome: rail.outcome, config: rail.config })).body,
      "quote_window", otherPayer.orderId);

    const otherRequest = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    await refused((await dispatchOrder({
      order: otherRequest, outcome: rail.outcome, config: rail.config, request: { message: "changed" },
    })).body, "quote_window", otherRequest.orderId);

    for (const [patch, reason] of [
      [{ providerQuoteHash: `0x${"00".repeat(32)}` }, "quote_window"],
      [{ providerQuoteHash: `0x${"5a".repeat(32)}` }, "quote_window"],
      [{ grossAmount: "10001" }, "price"],
    ] as const) {
      const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
      const quote = await resignQuote(order.quote, patch);
      await refused((await dispatchOrder({ order, outcome: rail.outcome, config: rail.config, quote })).body,
        reason, order.orderId);
    }
    const uncovered = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const wider = await resignQuote(uncovered.quote, { validBefore: uncovered.quote.validBefore + 600 });
    await refused((await dispatchOrder({
      order: uncovered, outcome: rail.outcome, config: rail.config, quote: wider,
    })).body, "quote_window", uncovered.orderId);
    const status = await rail.status(late.orderId, canonicalHash({ never: "admitted" }));
    expect(classifyStatusAnswer(status)).toBe("no_claim");
  });

  it("answers an authenticated exact replay with its claim even after the envelope expired", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body, answer, dispatchHash, envelope } = await admit(order);
    const before = json(answer);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((envelope.validBefore + 3_600) * 1_000);
    const replay = await rail.post("/standard-rail/dispatch", body);
    vi.useRealTimers();
    expect(classifyDispatchAnswer(replay)).toBe("accepted");
    const after = await acceptDispatchSnapshotAsGateway({ value: json(replay), dispatchHash });
    expect(after.body.taskId).toBe(before.taskId);
    expect(after.attestation).toEqual((before.terminalAttestation as { payload: unknown }).payload);
    expect(rail.executions).toBeGreaterThan(0);
    expect(await claims(order.orderId)).toBe(1);
  });

  it("serves an exact replay whose payload binding a later configuration would refuse", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body } = await admit(order);
    const original = rail.config.reputationOutcomeSchemaUid;
    rail.config.reputationOutcomeSchemaUid = `0x${"d0".repeat(32)}` as Hex;
    try {
      expect(classifyDispatchAnswer(await rail.post("/standard-rail/dispatch", body))).toBe("accepted");
      const fresh = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
      const refused = await rail.post("/standard-rail/dispatch",
        (await dispatchOrder({ order: fresh, outcome: rail.outcome, config: { ...rail.config,
          reputationOutcomeSchemaUid: original } })).body);
      expect(json(refused)).toEqual({ error: "dispatch_rejected", reason: "validator" });
    } finally {
      rail.config.reputationOutcomeSchemaUid = original;
    }
  });

  it("re-checks for a concurrently admitted delivery before sending a refusal", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const { body, dispatchHash } = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const verify = rail.evidence.verify.bind(rail.evidence);
    let calls = 0;
    let bothVerifying!: () => void;
    let answered!: () => void;
    const both = new Promise<void>((resolve) => { bothVerifying = resolve; });
    const anyAnswered = new Promise<void>((resolve) => { answered = resolve; });
    // Both deliveries pass the claim lookup; one is admitted while the other
    // then fails verification and must find that claim before refusing.
    rail.evidence.verify = async (args) => {
      calls += 1;
      if (calls === 2) {
        bothVerifying();
        await anyAnswered;
        throw new Error("RPC unavailable");
      }
      await both;
      return verify(args);
    };
    try {
      const deliver = () => rail.post("/standard-rail/dispatch", body).then((answer) => {
        answered();
        return answer;
      });
      for (const answer of await Promise.all([deliver(), deliver()])) {
        expect(classifyDispatchAnswer(answer)).toBe("accepted");
        await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash });
      }
      expect(calls).toBe(2);
      expect(await claims(order.orderId)).toBe(1);
    } finally {
      rail.evidence.verify = verify;
    }
  });

  it("stores an unstorable adapter result as the generic failure instead of stranding the claim", async () => {
    const odd = await startRailHarness({
      service: { adapter: { execute: async () => ({ status: "completed", message: "bad\u0000byte" }) } },
    });
    try {
      const order = await quoteOrder({ quotes: odd.quotes, outcome: odd.outcome });
      const { body, dispatchHash } = await dispatchOrder({ order, outcome: odd.outcome, config: odd.config });
      const answer = await odd.post("/standard-rail/dispatch", body);
      expect(classifyDispatchAnswer(answer)).toBe("accepted");
      const accepted = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash });
      expect(accepted.body.state).toBe("failed");
      const row = (await pool.query("SELECT state,result FROM provider_transactions WHERE order_id=$1",
        [order.orderId])).rows[0];
      expect(row).toEqual({
        state: "failed",
        result: {
          status: "failed",
          errorCode: "service_execution_failed",
          message: "The provider could not complete this request.",
        },
      });
    } finally {
      await odd.close();
      await rail.close();
      rail = await startRailHarness();
    }
  });

  it("never lets a different envelope replace an admitted claim", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const first = await admit(order);
    const executions = rail.executions;
    const second = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const answer = await rail.post("/standard-rail/dispatch", second.body);
    expect(answer.status).toBe(503);
    expect(answer.text).toBe("");
    expect(classifyDispatchAnswer(answer)).toBe("ambiguous");
    const conflicting = await rail.status(order.orderId, second.dispatchHash);
    expect(conflicting.status).toBe(409);
    expect(classifyStatusAnswer(conflicting)).toBe("unavailable");
    expect(classifyStatusAnswer(await rail.status(order.orderId, first.dispatchHash))).toBe("snapshot");
    expect(rail.executions).toBe(executions);
    expect(await claims(order.orderId)).toBe(1);
  });

  it("stops new quotes per listing version but never refuses a funded dispatch for capacity", async () => {
    const quoted = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const inflight = async (id: string, listingByte?: string) => pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before
       ) VALUES ($1,'https://gateway.example',$1,decode(md5($1) || md5($1),'hex'),
         decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
         '0x1111111111111111111111111111111111111111','dummy','echo',$2,'executing',
         now() + interval '5 minutes')`,
      [id, listingByte ? Buffer.from(listingByte.repeat(32), "hex")
        : Buffer.from(rail.outcome.listingManifestHash.slice(2), "hex")],
    );
    for (let index = 0; index < rail.outcome.maxOpenOrders; index += 1) {
      await inflight(`task-capacity-${index}`);
    }
    await inflight("task-previous-version", "ee");
    const listing = gatewayListing(rail.outcome);
    const full = await rail.post("/standard-rail/quote", {
      request: await gatewayQuoteRequest({ listing, request: { message: "more" }, payer: null }),
    });
    expect([full.status, json(full)]).toEqual([503, { error: "quote_unavailable", reason: "capacity" }]);
    const { answer, dispatchHash } = await admit(quoted);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
    await pool.query(
      `UPDATE provider_transactions SET state='completed',result='{"status":"completed"}',
         completed_at=now() WHERE id LIKE 'task-capacity-%'`,
    );
    const reopened = await rail.post("/standard-rail/quote", {
      request: await gatewayQuoteRequest({ listing, request: { message: "more" }, payer: null }),
    });
    expect(reopened.status).toBe(200);
  });

  it("refuses new dispatches before admission while product readiness is down but serves admitted work", async () => {
    const admitted = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const first = await admit(admitted);
    const waiting = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    rail.state.ready = false;
    const refused = await rail.post("/standard-rail/dispatch",
      (await dispatchOrder({ order: waiting, outcome: rail.outcome, config: rail.config })).body);
    expect([refused.status, json(refused)])
      .toEqual([503, { error: "dispatch_rejected", reason: "service_unavailable" }]);
    expect(await claims(waiting.orderId)).toBe(0);
    const replay = await rail.post("/standard-rail/dispatch", first.body);
    expect(classifyDispatchAnswer(replay)).toBe("accepted");
    expect(classifyStatusAnswer(await rail.status(admitted.orderId, first.dispatchHash))).toBe("snapshot");
  });

  it("fences a slow admission at the envelope deadline so no claim appears behind a no-claim answer", async () => {
    const fast = await startRailHarness({ outcome: { dispatchDeadlineSeconds: 30 } });
    try {
      const order = await quoteOrder({ quotes: fast.quotes, outcome: fast.outcome });
      const { body, envelope } = await dispatchOrder({
        order, outcome: fast.outcome, config: fast.config, issuedAt: nowSeconds() - 27,
      });
      // Admission passes its pre-checks with ~3 s left, then stalls past validBefore.
      const verify = fast.evidence.verify.bind(fast.evidence);
      fast.evidence.verify = async (args) => {
        await new Promise((resolve) => setTimeout(resolve, envelope.validBefore * 1_000 + 300 - Date.now()));
        return verify(args);
      };
      const answer = await fast.post("/standard-rail/dispatch", body);
      expect(fast.evidence.verified).toBe(1);
      expect([classifyDispatchAnswer(answer), json(answer)])
        .toEqual(["refused", { error: "dispatch_rejected", reason: "envelope_lifetime" }]);
      expect(await claims(order.orderId)).toBe(0);
      const status = await fast.status(order.orderId, canonicalHash(body.dispatch));
      expect(classifyStatusAnswer(status)).toBe("no_claim");
      expect(fast.executions).toBe(0);
    } finally {
      await fast.close();
      await rail.close();
      rail = await startRailHarness();
    }
  });
});
