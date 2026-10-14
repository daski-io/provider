import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireDatabase } from "./providerWireDatabase.js";

const state = vi.hoisted(() => ({ db: null as unknown as WireDatabase }));
vi.mock("../src/core/db/pool.js", async () => {
  const wire = await import("./providerWireDatabase.js");
  state.db = wire.createWireDatabase();
  return {
    pool: { query: wire.wireQuery(state.db), connect: wire.wireConnect(state.db) },
    checkDatabase: async () => true,
  };
});

import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import type { ServiceResult } from "../src/core/serviceRegistry/types.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import {
  claimRow,
  completedResult,
  context,
  expectWireAnswer,
  failedEvidence,
  fixture,
  keys,
  noteJobService,
  order,
} from "./providerWireFixture.js";
import { startWireHarness, type WireHarness } from "./providerWireHarness.js";

/**
 * Drives lite's quote, intake, dispatch, status and lifecycle handlers through
 * every vendored provider-wire vector a lite provider answers (README
 * "Matching an answer exactly"). Vectors for dynamic pricing, support state,
 * input, documents and task projections are full-only; the `rejected` and
 * `ambiguous` answer forms are what the gateway refuses, never produced here.
 */
const quote = fixture("quote.json");
const intake = fixture("intake.json");
const dispatch = fixture("dispatch.json");
const status = fixture("dispatch-status.json");
const lifecycle = fixture("lifecycle.json");
const terminal = fixture("terminal-evidence.json");

function vector(doc: { responses: Array<{ id: string }>; refusals?: Array<{ id: string }> }, id: string) {
  const found = [...doc.responses, ...(doc.refusals ?? [])].find((entry) => entry.id === id);
  if (!found) throw new Error(`fixture vector ${id} is missing`);
  return found as any;
}

const frozenAt = (result: ServiceResult, completedAt: number): Parameters<typeof claimRow>[0] => ({
  state: result.status,
  result,
  result_hash: Buffer.from(canonicalHash(result).slice(2), "hex"),
  completed_at: new Date(completedAt * 1_000),
});

let wire: WireHarness;

/** The provider quote the context order's QuoteV1 names, persisted by the real handler. */
async function persistOrderQuote(): Promise<void> {
  wire.at(context.times.quote);
  expectWireAnswer(await wire.send(quote.requests["fixed-payer-lowercase"].http),
    vector(quote, "fixed.payer-lowercase.accepted"));
  expect([...state.db.quotes.keys()]).toContain(order.providerQuoteHash.slice(2));
}

beforeAll(async () => {
  wire = await startWireHarness(state.db);
});

afterAll(async () => {
  await wire.close();
});

beforeEach(() => {
  wire.reset();
});

describe("provider-wire quote and intake vectors", () => {
  it("answers fixed quotes byte for byte at every provider clock the fixtures name", async () => {
    // A 120-second quote with the literal payer echo; at 31 s of skew the
    // same rule yields exactly the answers the gateway refuses at receipt.
    for (const id of [
      "fixed.payer-lowercase.accepted", "fixed.payer-null.accepted",
      "fixed.issued-30s-before-receipt.accepted", "fixed.issued-30s-after-receipt.accepted",
      "fixed.issued-31s-before-receipt.rejected", "fixed.issued-31s-after-receipt.rejected",
    ]) {
      const expected = vector(quote, id);
      wire.at(expected.provider.now);
      expectWireAnswer(await wire.send(quote.requests[expected.request].http), expected);
    }
  });

  it("answers intake with the vector's bytes except supported, which lite leaves undetermined", async () => {
    const expected = vector(intake, "accepted");
    wire.at(expected.provider.now);
    const answer = await wire.send(intake.requests.intake.http);
    // Lite declares no contextual intake, so `supported: null`: availability
    // was not determined (gateway docs/intake-discovery.md). Every other
    // field and the signing rule match the vector.
    const { signature: _signature, ...payload } = expected.response.body;
    const undetermined = { ...payload, supported: null };
    const signature = await privateKeyToAccount(keys.providerAuthority!.privateKey)
      .signMessage({ message: { raw: canonicalHash(undetermined) } });
    expectWireAnswer(answer, { ...expected, response: { ...expected.response, body: { ...undetermined, signature } } });
  });
});

describe("provider-wire dispatch and dispatch-status vectors", () => {
  it("completes and fails a synchronous dispatch with the vectors' attested bytes", async () => {
    for (const [id, result] of [["completed.accepted", completedResult], ["failed.accepted", failedEvidence]] as const) {
      wire.reset();
      await persistOrderQuote();
      wire.execute = id === "failed.accepted"
        ? async () => { throw new Error("upstream detail that must not leak"); }
        : async () => result;
      const expected = vector(dispatch, id);
      wire.at(expected.provider.now);
      expectWireAnswer(await wire.send(dispatch.requests.initial.http), expected);
      expect(state.db.claims.get(order.orderId)?.result).toEqual(result);
    }
  });

  it("answers an admitted exact replay as working, at fresh and skewed database clocks", async () => {
    for (const id of [
      "working.accepted", "accepted.operations-300s-old", "accepted.operations-30s-ahead",
      // A database clock beyond the gateway's freshness window yields exactly
      // the observations it refuses; lite never signs a cached observation.
      "rejected.operations-301s-old", "rejected.operations-31s-ahead",
    ]) {
      const expected = vector(dispatch, id);
      wire.plant();
      wire.at(expected.provider.now, expected.provider.operations.observedAt);
      expectWireAnswer(await wire.send(dispatch.requests.initial.http), expected);
    }
  });

  // L03: an external-job admission acknowledges durable acceptance with the
  // vector's `submitted` bytes; its phases replay as `submitted`/`working`.
  it("admits an external-job dispatch as submitted and replays its phases as the vectors", async () => {
    clearServicesForTests();
    registerService(noteJobService());
    state.db.asyncAdmission = true;
    await persistOrderQuote();
    const submitted = vector(dispatch, "submitted.accepted");
    wire.at(submitted.provider.now);
    expectWireAnswer(await wire.send(dispatch.requests.initial.http), submitted);
    expect(state.db.claims.get(order.orderId)).toMatchObject({ id: order.providerTaskId, state: "external_job" });
    expect(state.db.jobs.get(order.providerTaskId)).toMatchObject({ phase: "queued", adapter_version: "v1" });
    for (const [phase, id] of [
      ["queued", "submitted.accepted"], ["starting", "working.accepted"],
      ["reconciling", "working.accepted"], ["polling", "working.accepted"],
    ] as const) {
      wire.reset();
      wire.plant({ state: "external_job", job_phase: phase });
      const expected = vector(dispatch, id);
      wire.at(expected.provider.now, expected.provider.operations.observedAt);
      expectWireAnswer(await wire.send(dispatch.requests.initial.http), expected);
    }
  });

  it("refuses definitely before admission and answers uncertainty with the empty 503", async () => {
    // No persisted provider quote: the QuoteV1 binding cannot be proven.
    const quoteWindow = vector(dispatch, "refused.quote-window");
    wire.at(quoteWindow.provider.now);
    expectWireAnswer(await wire.send(dispatch.requests.initial.http), quoteWindow);
    expect(state.db.claims.size).toBe(0);

    await persistOrderQuote();
    wire.rail.ready = false;
    const unavailable = vector(dispatch, "refused.service-unavailable");
    wire.at(unavailable.provider.now);
    expectWireAnswer(await wire.send(dispatch.requests.initial.http), unavailable);
    expect(state.db.claims.size).toBe(0);

    wire.rail.ready = true;
    state.db.failLookups = true;
    const ambiguous = vector(dispatch, "ambiguous.empty-503");
    wire.at(ambiguous.provider.now);
    expectWireAnswer(await wire.send(dispatch.requests.initial.http), ambiguous);
  });

  it("answers status polls for the original hash and the no-claim 404 only on absence", async () => {
    for (const [id, claim] of [
      ["working.accepted", {}],
      ["completed.accepted", frozenAt(completedResult, context.times.completed)],
      ["failed.accepted", frozenAt(failedEvidence, context.times.completed)],
      ["no-claim.within-grace", null],
      ["no-claim.after-grace", null],
    ] as const) {
      wire.reset();
      if (claim) wire.plant(claim);
      const expected = vector(status, id);
      wire.at(expected.provider.now);
      expectWireAnswer(await wire.send(status.requests[expected.request].http), expected);
    }
  });
});

describe("provider-wire lifecycle and terminal-evidence vectors", () => {
  const completed = frozenAt(completedResult, context.times.completed);

  it("answers status and artifact reads byte for byte", async () => {
    for (const [doc, id, claim] of [
      [lifecycle, "status.working.accepted", {}],
      // An external job past its start answers the same working read.
      [lifecycle, "status.working.accepted", { state: "external_job", job_phase: "polling" }],
      [lifecycle, "status.completed.accepted", completed],
      [lifecycle, "artifact.service-result.accepted", completed],
      [terminal, "service-result.lifecycle-attestation.accepted", completed],
    ] as const) {
      wire.reset();
      wire.plant(claim);
      const expected = vector(doc, id);
      wire.at(expected.provider.now);
      expectWireAnswer(await wire.send(lifecycle.requests[expected.request].http), expected);
    }
  });

  it("answers a payer-signed read with the same bytes as the read capability", async () => {
    // The answer does not depend on the authorization form: the payer-signed
    // requests of the fixtures yield the read-capability vectors' bodies.
    for (const [request, id] of [
      ["status.payer-signed.completed", "status.completed.accepted"],
      ["artifact.payer-signed.completed", "artifact.service-result.accepted"],
    ] as const) {
      wire.reset();
      wire.plant(completed);
      const expected = vector(lifecycle, id);
      wire.at(expected.provider.now);
      expectWireAnswer(await wire.send(lifecycle.requests[request].http), expected);
    }
  });

  it("gives exactly the named refusals and no effect for actions lite does not serve", async () => {
    for (const id of [
      "artifact.unavailable", "support.unsupported", "input.unsupported", "cancel.unsupported",
      "status.unavailable.read-capability",
    ]) {
      wire.reset();
      wire.plant();
      state.db.failLookups = id === "status.unavailable.read-capability";
      const expected = vector(lifecycle, id);
      const request = lifecycle.requests[expected.request];
      wire.at(request.gateway.now);
      const before = JSON.stringify(state.db.claims.get(order.orderId));
      expectWireAnswer(await wire.send(request.http), expected);
      expect(JSON.stringify(state.db.claims.get(order.orderId))).toBe(before);
      expect(state.db.statements.some((sql) => /\b(?:INSERT|UPDATE)\b/.test(sql)
        && !sql.includes("rate_limit_buckets"))).toBe(false);
    }
  });
});
