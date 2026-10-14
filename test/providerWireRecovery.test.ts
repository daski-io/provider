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

import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { acceptDispatchSnapshotAsGateway, classifyDispatchAnswer } from "./gatewayWire.js";
import { completedResult, context, expectWireAnswer, fixture, keys, order } from "./providerWireFixture.js";
import { startWireHarness, type WireHarness } from "./providerWireHarness.js";

/**
 * The fixture dispatch requests that carry no answer vector of their own: a
 * fresh envelope after a definite refusal, and a first dispatch 26 hours after
 * the quote expired (C-T04). Each answer is judged by the gateway port with
 * the fixture's provider keys.
 */
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
let wire: WireHarness;

const judge = (text: string, request: { dispatchHash: `0x${string}` }, now: number) =>
  acceptDispatchSnapshotAsGateway({
    value: JSON.parse(text),
    dispatchHash: request.dispatchHash,
    providerAuthorityKey: keys.providerAuthority!.address,
    providerTerminalAttestationKey: keys.providerTerminalAttestation!.address,
    now,
  });

beforeAll(async () => {
  wire = await startWireHarness(state.db);
});

afterAll(async () => {
  await wire.close();
});

beforeEach(() => {
  wire.reset();
});

describe("provider-wire dispatch recovery requests", () => {
  it("admits the gateway's fresh envelope after a definite refusal, once", async () => {
    // The initial dispatch is refused before admission: no provider quote yet.
    wire.at(context.times.dispatchAnswered);
    const refused = await wire.send(dispatch.requests.initial.http);
    expect(classifyDispatchAnswer(refused)).toBe("refused");
    wire.at(context.times.quote);
    expectWireAnswer(await wire.send(quote.requests["fixed-payer-lowercase"].http),
      quote.responses.find((entry: { id: string }) => entry.id === "fixed.payer-lowercase.accepted"));
    const retry = dispatch.requests["retry-after-refusal"];
    wire.at(retry.gateway.now + 1);
    const answer = await wire.send(retry.http);
    const accepted = await judge(answer.text, retry, retry.gateway.now + 1);
    expect(accepted.attestation).toMatchObject({ state: "completed", resultHash: canonicalHash(completedResult) });
    // The original envelope never replaces the admitted retry.
    wire.at(retry.gateway.now + 2);
    expect((await wire.send(dispatch.requests.initial.http)).status).toBe(503);
    expect(state.db.claims.size).toBe(1);
  });

  it("admits a timely payment first dispatched 26 hours after its quote expired", async () => {
    wire.at(context.times.quote);
    await wire.send(quote.requests["fixed-payer-lowercase"].http);
    const delayed = dispatch.requests["delayed-first-dispatch"];
    expect(delayed.gateway.now - delayed.http.body.quote.validBefore).toBeGreaterThan(24 * 3_600);
    wire.at(delayed.gateway.now + 1);
    const answer = await wire.send(delayed.http);
    const accepted = await judge(answer.text, delayed, delayed.gateway.now + 1);
    expect(accepted.body).toMatchObject({ taskId: order.providerTaskId, state: "completed" });
    expect(accepted.attestation?.completedAt).toBe(delayed.gateway.now + 1);
  });
});
