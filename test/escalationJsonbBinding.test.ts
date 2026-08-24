import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { createEscalation, type ReviewAction } from "../src/core/db/queries/escalations.js";

/// The typed-review columns `evidence` and `available_actions` are JSONB, so
/// their bound parameters must be JSON TEXT. Handing node-pg a JS array
/// instead serializes it as a POSTGRES ARRAY literal: a non-empty array goes
/// on the wire as {"{\"label\":…}"} and Postgres rejects the insert with
/// `invalid input syntax for type json`, while an empty one lands as the
/// object {} rather than []. Neither is visible from the SQL text, and the
/// in-repo suite runs without a live Postgres — so assert what the driver
/// would actually put on the wire, using node-pg's own serializer.
const requireCjs = createRequire(import.meta.url);
const { prepareValue } = requireCjs("pg/lib/utils") as {
  prepareValue: (value: unknown) => unknown;
};

const EVIDENCE_PARAM = 14;
const ACTIONS_PARAM = 15;

const ACTIONS: ReviewAction[] = [
  { label: "Clear false positive", value: "clear the hold", effect: "Resumes automation." },
  { label: "Confirm match", value: "confirm the hold", effect: "Blocks the buyer." },
];

/// Stands in for Postgres: captures the bound parameters and returns a row
/// built from them, the way RETURNING * would.
function fakeDb() {
  const captured: unknown[] = [];
  const db = {
    async query(text: string, values: unknown[] = []) {
      if (!text.includes("INSERT INTO escalations")) return { rows: [], rowCount: 0 };
      captured.push(...values);
      return {
        rows: [{
          id: values[0],
          transaction_id: values[1],
          question: values[2],
          source: values[3],
          status: "awaiting_human",
          assignee: values[5],
          response: null,
          agent_recommendation: values[7],
        }],
        rowCount: 1,
      };
    },
  };
  return { captured, db };
}

/// What node-pg would actually send for this parameter.
function onTheWire(value: unknown): string {
  return String(prepareValue(value));
}

describe("escalation JSONB parameter binding", () => {
  it("sends review evidence and actions as JSON Postgres can parse", async () => {
    const { captured, db } = fakeDb();

    await createEscalation({
      transaction_id: "task-probe",
      question: "Adjudicate the exact check.",
      source: "screening",
      status: "awaiting_human",
      assignee: "human",
      review_kind: "screening_adjudication",
      dedupe_key: "screening:probe",
      evidence: { checkId: "probe", refundBlocked: true },
      available_actions: ACTIONS,
    }, db as never);

    const actionsWire = onTheWire(captured[ACTIONS_PARAM]);
    const evidenceWire = onTheWire(captured[EVIDENCE_PARAM]);

    expect(() => JSON.parse(actionsWire)).not.toThrow();
    expect(() => JSON.parse(evidenceWire)).not.toThrow();
    expect(JSON.parse(actionsWire)).toEqual(ACTIONS);
    expect(JSON.parse(evidenceWire)).toEqual({
      version: 1,
      checkId: "probe",
      refundBlocked: true,
    });
  });

  it("defaults available_actions to an empty JSON array, never an object", async () => {
    const { captured, db } = fakeDb();

    await createEscalation({
      transaction_id: "task-probe",
      question: "No actions offered.",
      source: "operator",
    }, db as never);

    const actions = JSON.parse(onTheWire(captured[ACTIONS_PARAM]));
    expect(Array.isArray(actions)).toBe(true);
    expect(actions).toEqual([]);
    expect(JSON.parse(onTheWire(captured[EVIDENCE_PARAM]))).toEqual({
      version: 1,
      classificationRequired: true,
    });
  });

  it("would reject the raw-array binding this test exists to prevent", () => {
    // Documents the exact defect: node-pg turns a JS array into a Postgres
    // array literal, which Postgres cannot cast to JSONB.
    expect(() => JSON.parse(onTheWire(ACTIONS))).toThrow();
    expect(JSON.parse(onTheWire([]))).not.toEqual([]);
  });
});
