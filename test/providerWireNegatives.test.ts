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

import { operationsObservation } from "../src/core/standardRail/dispatchResponse.js";
import { appliesToLite, claimRow, fixture } from "./providerWireFixture.js";
import { startWireHarness, type WireHarness } from "./providerWireHarness.js";

const negatives = fixture("envelope-negatives.json");
const operations = fixture("operations.json");

/**
 * Authenticated dispatch envelopes whose other bindings fail: the claim for
 * the order is read before the refusal because an exact replay of an admitted
 * dispatch must be answered even after its envelope expired (C03). The read
 * admits and changes nothing; with no claim the answer is the refusal.
 */
const READ_BEFORE_REFUSAL = new Set([
  "dispatch.expired", "dispatch.quote-signed-by-dispatch-key", "dispatch.request-hash-mismatch",
]);
const ADMISSION_OR_MUTATION = /\b(?:INSERT|UPDATE|DELETE)\b/;

let wire: WireHarness;

beforeAll(async () => {
  wire = await startWireHarness(state.db);
});

afterAll(async () => {
  await wire.close();
});

beforeEach(() => {
  wire.reset();
});

describe("provider-wire envelope negatives", () => {
  const vectors = (negatives.vectors as Array<any>).filter(appliesToLite);

  it("covers every handler lite serves", () => {
    expect(new Set(vectors.map((entry) => entry.handler)))
      .toEqual(new Set(["quote", "intake", "dispatch", "status", "lifecycle"]));
  });

  for (const negative of vectors) {
    it(`refuses ${negative.id} without admission, mutation or an absence claim`, async () => {
      // Status and lifecycle negatives meet an existing claim, so a refusal
      // can never be mistaken for proof of absence.
      if (negative.handler === "status" || negative.handler === "lifecycle") wire.plant();
      wire.at(negative.provider.now);
      const answer = await wire.send({ url: negative.http.url, headers: negative.http.headers, body: negative.http.body });
      expect(answer.status, answer.text).toBeGreaterThanOrEqual(400);
      expect(answer.status, answer.text).toBeLessThan(500);
      const body = JSON.parse(answer.text) as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
      if (negative.handler === "dispatch") expect(body.error).toBe("dispatch_rejected");
      if (negative.handler === "status") expect(body.reason).not.toBe("outcome_policy");
      expect(state.db.statements.filter((sql) => ADMISSION_OR_MUTATION.test(sql)
        && !sql.includes("rate_limit_buckets"))).toEqual([]);
      const reads = state.db.statements.filter((sql) => sql.includes("FROM provider_transactions")
        || sql.includes("FROM provider_quotes"));
      if (!READ_BEFORE_REFUSAL.has(negative.id)) expect(reads, negative.check.kind).toEqual([]);
      expect(state.db.claims.size).toBe(negative.handler === "status" || negative.handler === "lifecycle" ? 1 : 0);
    });
  }
});

describe("provider-wire operations sequences", () => {
  it("observes exactly the all-null projections lite publishes and refuses to sign any other", () => {
    let observed = 0;
    for (const sequence of (operations.sequences as Array<any>).filter(appliesToLite)) {
      for (const step of sequence.steps) {
        const { fulfillment, support, recovery, revision, observedAt } = step.operations;
        const row = claimRow({
          observed_at: String(observedAt),
          operations_revision: revision,
          operations_projection: { fulfillment, support, recovery },
        });
        if (fulfillment === null && support === null && recovery === null) {
          expect(operationsObservation(row), sequence.id).toEqual(step.operations);
          observed += 1;
        } else {
          // Lite has no support, fulfillment or recovery state to publish.
          expect(() => operationsObservation(row), sequence.id).toThrow();
        }
      }
    }
    expect(observed).toBeGreaterThanOrEqual(8);
  });
});
