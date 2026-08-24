import { beforeEach, describe, expect, it, vi } from "vitest";

// Confirmation-intent lifecycle: preview → browser approval (by intent id,
// bound to wallet/session/thread) → later-turn consumption executing the
// STORED payload. Regression coverage for the approval-UX incident: chat
// text alone never approves; re-previews dedupe/supersede; expiry re-issues.

interface StoredIntent {
  id: string;
  operator_wallet: string;
  session_id: string;
  thread_id: string;
  origin_turn_id: string;
  action_name: string;
  arguments_hash: Buffer;
  target_type: string;
  target_id: string;
  pending_payload_encrypted: string | null;
  issued_seq: number;
  expires_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  approved_session_id: string | null;
  consumed_at: Date | null;
  voided_at: Date | null;
}

const db = vi.hoisted(() => ({
  intents: [] as StoredIntent[],
  seq: 0,
  audits: [] as string[],
  locked: new Set<string>(),
}));

const hoisted = vi.hoisted(() => {
  const same = (a: Buffer, b: unknown): boolean =>
    Buffer.isBuffer(b) && a.equals(b);

  const live = (row: StoredIntent): boolean =>
    !row.consumed_at && !row.voided_at && row.expires_at.getTime() > Date.now();

  const query = async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };

    if (sql.includes("INSERT INTO operator_confirmation_intents")) {
      const row: StoredIntent = {
        id: String(params[0]),
        operator_wallet: String(params[1]).toLowerCase(),
        session_id: String(params[2]),
        thread_id: String(params[3]),
        origin_turn_id: String(params[4]),
        action_name: String(params[5]),
        arguments_hash: params[6] as Buffer,
        target_type: String(params[7]),
        target_id: String(params[8]),
        pending_payload_encrypted: String(params[9]),
        issued_seq: ++db.seq,
        expires_at: params[10] as Date,
        approved_at: null,
        approved_by: null,
        approved_session_id: null,
        consumed_at: null,
        voided_at: null,
      };
      db.intents.push(row);
      return { rows: [{ id: row.id, expires_at: row.expires_at }], rowCount: 1 };
    }

    if (sql.includes("SELECT id, origin_turn_id")) {
      // findOpenConfirmationIntent
      const matches = db.intents
        .filter(
          (row) =>
            row.operator_wallet === String(params[0]).toLowerCase() &&
            row.session_id === params[1] &&
            row.thread_id === params[2] &&
            row.action_name === params[3] &&
            same(row.arguments_hash, params[4]) &&
            row.target_type === params[5] &&
            row.target_id === params[6] &&
            live(row),
        )
        .sort((a, b) => b.issued_seq - a.issued_seq);
      const row = matches[0];
      return row
        ? {
            rows: [{
              id: row.id,
              origin_turn_id: row.origin_turn_id,
              approved_at: row.approved_at,
              expires_at: row.expires_at,
              pending_payload_encrypted: row.pending_payload_encrypted,
              action_name: row.action_name,
              target_type: row.target_type,
              target_id: row.target_id,
              thread_id: row.thread_id,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }

    if (sql.includes("SELECT id, pending_payload_encrypted")) {
      const eligible = db.intents
        .filter(
          (row) =>
            row.operator_wallet === String(params[0]).toLowerCase() &&
            row.session_id === params[1] &&
            row.thread_id === params[2] &&
            row.origin_turn_id !== params[3] &&
            row.action_name === params[4] &&
            same(row.arguments_hash, params[5]) &&
            row.target_type === params[6] &&
            row.target_id === params[7] &&
            row.approved_at &&
            row.approved_by === String(params[0]).toLowerCase() &&
            row.approved_session_id === params[1] &&
            live(row) &&
            !db.locked.has(row.id),
        )
        .sort(
          (a, b) =>
            (a.approved_at!.getTime() - b.approved_at!.getTime()) ||
            (a.issued_seq - b.issued_seq),
        );
      const row = eligible[0];
      if (!row) return { rows: [], rowCount: 0 };
      db.locked.add(row.id);
      return {
        rows: [{
          id: row.id,
          pending_payload_encrypted: row.pending_payload_encrypted,
          action_name: row.action_name,
          target_type: row.target_type,
          target_id: row.target_id,
          thread_id: row.thread_id,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("SET consumed_at")) {
      const row = db.intents.find(
        (candidate) => candidate.id === params[0] && live(candidate),
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed_at = new Date();
      db.locked.delete(row.id);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("confirmation_payload_unavailable")) {
      const row = db.intents.find(
        (candidate) =>
          candidate.id === params[0] &&
          !candidate.consumed_at &&
          !candidate.voided_at,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.voided_at = new Date();
      db.locked.delete(row.id);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET voided_at")) {
      const row = db.intents.find(
        (candidate) =>
          candidate.id === params[0] &&
          !candidate.approved_at &&
          !candidate.consumed_at &&
          !candidate.voided_at,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.voided_at = new Date();
      return {
        rows: [{
          action_name: row.action_name,
          target_type: row.target_type,
          target_id: row.target_id,
          thread_id: row.thread_id,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("SET approved_at")) {
      const row = db.intents.find(
        (candidate) =>
          candidate.id === params[0] &&
          candidate.operator_wallet === String(params[1]).toLowerCase() &&
          candidate.session_id === params[2] &&
          candidate.thread_id === params[3] &&
          !candidate.approved_at &&
          live(candidate),
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.approved_at = new Date();
      row.approved_by = String(params[1]).toLowerCase();
      row.approved_session_id = String(params[2]);
      return {
        rows: [{
          thread_id: row.thread_id,
          action_name: row.action_name,
          target_type: row.target_type,
          target_id: row.target_id,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("SELECT thread_id, action_name")) {
      // approve idempotent fallback
      const row = db.intents.find(
        (candidate) =>
          candidate.id === params[0] &&
          candidate.operator_wallet === String(params[1]).toLowerCase() &&
          candidate.session_id === params[2] &&
          candidate.thread_id === params[3] &&
          candidate.approved_at &&
          candidate.approved_by === String(params[1]).toLowerCase() &&
          candidate.approved_session_id === params[2] &&
          live(candidate),
      );
      return row
        ? {
            rows: [{
              thread_id: row.thread_id,
              action_name: row.action_name,
              target_type: row.target_type,
              target_id: row.target_id,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }

    if (sql.includes("thread_id = ANY")) {
      const threadIds = params[0] as string[];
      const rows = db.intents
        .filter(
          (row) =>
            threadIds.includes(row.thread_id) &&
            row.operator_wallet === String(params[1]).toLowerCase() &&
            row.session_id === params[2] &&
            !row.approved_at &&
            live(row),
        )
        .sort((a, b) => a.issued_seq - b.issued_seq)
        .map((row) => ({
          id: row.id,
          thread_id: row.thread_id,
          action_name: row.action_name,
          target_type: row.target_type,
          target_id: row.target_id,
          expires_at: row.expires_at,
        }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("SELECT id, approved_at")) {
      const ids = params[0] as string[];
      const rows = db.intents
        .filter((row) => ids.includes(row.id))
        .map((row) => ({
          id: row.id,
          approved_at: row.approved_at,
          consumed_at: row.consumed_at,
          voided_at: row.voided_at,
          expires_at: row.expires_at,
          execution_status: row.consumed_at ? "executing" : "not_started",
          execution_error_summary: null,
        }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query: vi.fn(query) };
});

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: hoisted.query,
    connect: vi.fn(async () => ({ query: hoisted.query, release: vi.fn() })),
  },
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: vi.fn(async (_client, event: { type: string }) => {
    db.audits.push(event.type);
  }),
}));

import {
  canonicalActionArguments,
  consumeApprovedConfirmationIntent,
  createConfirmationIntent,
  getConfirmationIntentStates,
  listPendingConfirmationIntentsForThreads,
  type ConfirmationBinding,
} from "../src/core/db/queries/confirmationIntents.js";
import { approveConfirmationIntent } from "../src/core/db/queries/confirmationIntentApprovals.js";
import { redactConfirmationTokens } from "../src/core/agents/operatorAgent/audit.js";
import { confirmationGate } from "../src/core/agents/operatorAgent/confirmation.js";

const base: ConfirmationBinding = {
  operatorWallet: "0xoperator",
  sessionId: "11111111-1111-1111-1111-111111111111",
  threadId: "22222222-2222-2222-2222-222222222222",
  turnId: "33333333-3333-3333-3333-333333333333",
  actionName: "issue_manual_refund",
  arguments: { transaction_id: "tx-1", amount_atomic: "1000000" },
  targetType: "transaction",
  targetId: "tx-1",
};
const LATER_TURN = "44444444-4444-4444-4444-444444444444";
const PAYLOAD = { reason: "duplicate" };

function humanCtx(turnId: string) {
  return {
    actor: base.operatorWallet,
    sessionId: base.sessionId,
    threadId: base.threadId,
    turnId,
    mode: "human" as const,
  };
}

async function gate(args?: {
  turnId?: string;
  arguments?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) {
  return confirmationGate({
    ctx: humanCtx(args?.turnId ?? base.turnId),
    actionName: base.actionName,
    arguments: args?.arguments ?? base.arguments,
    payload: args?.payload ?? PAYLOAD,
    targetType: base.targetType,
    targetId: base.targetId,
  });
}

async function approve(intentId: string) {
  return approveConfirmationIntent({
    intentId,
    operatorWallet: base.operatorWallet,
    sessionId: base.sessionId,
    threadId: base.threadId,
  });
}

beforeEach(() => {
  db.intents.length = 0;
  db.seq = 0;
  db.audits.length = 0;
  db.locked.clear();
  hoisted.query.mockClear();
});

describe("operator confirmation intents", () => {
  it("fails closed unless the caller declares an authenticated human mode", async () => {
    const context = {
      actor: base.operatorWallet,
      sessionId: base.sessionId,
      threadId: base.threadId,
      turnId: base.turnId,
    };
    await expect(confirmationGate({
      ctx: context,
      actionName: base.actionName,
      arguments: base.arguments,
      targetType: base.targetType,
      targetId: base.targetId,
    })).resolves.toMatchObject({
      status: "denied",
      reason: "confirmation_context_required",
    });
    expect(hoisted.query).not.toHaveBeenCalled();
  });

  it("rejects prototype keys and non-JSON structures before hashing", () => {
    const polluted = JSON.parse(
      '{"transaction_id":"tx-1","__proto__":{"amount_atomic":"999999999"}}',
    ) as Record<string, unknown>;
    expect(() => canonicalActionArguments(polluted)).toThrow(/forbidden key '__proto__'/);
    expect(() => canonicalActionArguments({ nested: { constructor: "drift" } })).toThrow(
      /forbidden key 'constructor'/,
    );
    expect(() => canonicalActionArguments({ amount: Number.POSITIVE_INFINITY })).toThrow(
      /finite JSON numbers/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalActionArguments(cyclic)).toThrow(/cycles/);

    const nullPrototype = Object.assign(Object.create(null), { transaction_id: "tx-1" });
    expect(() => canonicalActionArguments(nullPrototype)).toThrow(/standard JSON objects/);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "amount", {
      enumerable: true,
      get: () => "1000000",
    });
    expect(() => canonicalActionArguments(accessor)).toThrow(/data properties/);

    const symbolKeyed = { transaction_id: "tx-1" } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden-target")] = "tx-2";
    expect(() => canonicalActionArguments(symbolKeyed)).toThrow(/symbol keys/);

    const arrayWithExtra = ["tx-1"] as Array<unknown> & { target?: string };
    arrayWithExtra.target = "tx-2";
    expect(() => canonicalActionArguments({ values: arrayWithExtra })).toThrow(
      /extra properties/,
    );
  });

  it("caps canonical confirmation argument size and depth", () => {
    expect(() => canonicalActionArguments({ reason: "x".repeat(65 * 1024) })).toThrow(
      /size limit/,
    );
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let index = 0; index < 21; index++) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    expect(() => canonicalActionArguments(root)).toThrow(/depth limit/);
  });

  it("redacts legacy confirmation bearers from tool-call audit payloads", () => {
    expect(
      redactConfirmationTokens(
        JSON.stringify({ confirmation_token: "secret-token", target: "tx-1" }),
      ),
    ).toBe('{"confirmation_token":"<redacted>","target":"tx-1"}');
  });

  it("previews once, dedupes the re-ask, and executes the stored payload after the browser click", async () => {
    const preview = await gate();
    expect(preview).toMatchObject({ status: "pending", issued: true });
    const intentId = preview.status === "pending" ? preview.intentId : "";

    // Same binding + payload asked again (any turn): points back at the live
    // button instead of minting a duplicate.
    const reAsk = await gate({ turnId: LATER_TURN });
    expect(reAsk).toMatchObject({ status: "pending", issued: false, intentId });
    expect(db.intents).toHaveLength(1);

    expect((await approve(intentId)).ok).toBe(true);

    // The follow-up turn consumes the approval and receives the STORED
    // payload — the model's retyped text never drives execution.
    const executed = await gate({
      turnId: LATER_TURN,
      payload: { reason: "retyped drift" },
    });
    expect(executed).toEqual({
      status: "approved",
      intentId,
      payload: { reason: "duplicate" },
    });
    expect(db.intents[0]!.consumed_at).toBeInstanceOf(Date);
    expect(db.audits).toContain("operator.confirmation_approved");
    expect(db.audits).toContain("operator.confirmation_consumed");
  });

  it("never approves from chat text alone — an unclicked intent stays pending across turns", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";

    // Operator typed "approve clear" (a new turn) but never clicked: the
    // gate must keep waiting on the same intent, not execute and not mint.
    for (const turn of [LATER_TURN, "55555555-5555-5555-5555-555555555555"]) {
      const retry = await gate({ turnId: turn });
      expect(retry).toMatchObject({ status: "pending", issued: false, intentId });
    }
    expect(db.intents).toHaveLength(1);
    expect(db.intents[0]!.consumed_at).toBeNull();
  });

  it("refuses same-turn execution of a just-approved intent", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";
    expect((await approve(intentId)).ok).toBe(true);
    await expect(gate()).resolves.toMatchObject({
      status: "denied",
      reason: "same_turn_confirmation",
    });
    expect(db.intents[0]!.consumed_at).toBeNull();
  });

  it("binds consumption to operator, session, thread, action, stable args, and target", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";
    expect((await approve(intentId)).ok).toBe(true);

    // A drifted amount is a different binding: the approved intent must not
    // be consumable, and the call previews a NEW intent instead.
    const drifted = await gate({
      turnId: LATER_TURN,
      arguments: { transaction_id: "tx-1", amount_atomic: "2000000" },
    });
    expect(drifted).toMatchObject({ status: "pending", issued: true });
    expect(drifted.status === "pending" && drifted.intentId).not.toBe(intentId);
    expect(db.intents[0]!.consumed_at).toBeNull();

    const otherBindings: Array<Partial<ConfirmationBinding>> = [
      { operatorWallet: "0xother" },
      { sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { threadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      { actionName: "withhold_refund" },
      { targetId: "tx-2" },
    ];
    for (const mutation of otherBindings) {
      expect(
        await consumeApprovedConfirmationIntent({
          ...base,
          turnId: LATER_TURN,
          ...mutation,
        }),
      ).toBeNull();
    }
    expect(db.intents[0]!.consumed_at).toBeNull();
  });

  it("supersedes an unapproved preview when the content changes", async () => {
    const first = await gate();
    const firstId = first.status === "pending" ? first.intentId : "";

    const second = await gate({ payload: { reason: "chargeback risk" } });
    expect(second).toMatchObject({ status: "pending", issued: true });
    const secondId = second.status === "pending" ? second.intentId : "";
    expect(secondId).not.toBe(firstId);
    expect(db.intents[0]!.voided_at).toBeInstanceOf(Date);
    expect(db.audits).toContain("operator.confirmation_superseded");

    // The superseded button is dead.
    expect((await approve(firstId)).ok).toBe(false);
    // The fresh one approves and executes its own stored content.
    expect((await approve(secondId)).ok).toBe(true);
    await expect(gate({ turnId: LATER_TURN, payload: { reason: "chargeback risk" } }))
      .resolves.toEqual({
        status: "approved",
        intentId: secondId,
        payload: { reason: "chargeback risk" },
      });
  });

  it("re-issues a fresh preview after expiry instead of dead-ending", async () => {
    const first = await gate();
    const firstId = first.status === "pending" ? first.intentId : "";
    db.intents[0]!.expires_at = new Date(0);

    expect((await approve(firstId)).ok).toBe(false);
    const again = await gate({ turnId: LATER_TURN });
    expect(again).toMatchObject({ status: "pending", issued: true });
    expect(again.status === "pending" && again.intentId).not.toBe(firstId);
    expect(db.intents).toHaveLength(2);
  });

  it("is idempotent across approval retry and single-use under concurrent consumption", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";
    expect(await approve(intentId)).toMatchObject({ ok: true, newlyApproved: true });
    expect(await approve(intentId)).toMatchObject({ ok: true, newlyApproved: false });
    const outcomes = await Promise.all([
      consumeApprovedConfirmationIntent({ ...base, turnId: LATER_TURN }),
      consumeApprovedConfirmationIntent({
        ...base,
        turnId: "55555555-5555-5555-5555-555555555555",
      }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.filter(Boolean)[0]).toMatchObject({ payload: { reason: "duplicate" } });
    expect(db.audits).toContain("operator.confirmation_approved");
    expect(db.audits).toContain("operator.confirmation_consumed");
  });

  it("lists only this session's unapproved live intents for the pinned bar", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";

    const pending = await listPendingConfirmationIntentsForThreads({
      threadIds: [base.threadId],
      operatorWallet: base.operatorWallet,
      sessionId: base.sessionId,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: intentId,
      threadId: base.threadId,
      actionName: base.actionName,
    });

    expect((await approve(intentId)).ok).toBe(true);
    expect(
      await listPendingConfirmationIntentsForThreads({
        threadIds: [base.threadId],
        operatorWallet: base.operatorWallet,
        sessionId: base.sessionId,
      }),
    ).toHaveLength(0);

    const states = await getConfirmationIntentStates([intentId]);
    expect(states.get(intentId)?.approvedAt).toBeInstanceOf(Date);
  });

  it("createConfirmationIntent stores the canonicalized payload", async () => {
    const issued = await createConfirmationIntent(base, { reason: "duplicate" });
    expect(issued.id).toBeTruthy();
    expect(db.intents[0]!.pending_payload_encrypted).not.toContain("duplicate");
  });

  it("voids an approved intent instead of executing unavailable ciphertext", async () => {
    const preview = await gate();
    const intentId = preview.status === "pending" ? preview.intentId : "";
    expect((await approve(intentId)).ok).toBe(true);
    db.intents[0]!.pending_payload_encrypted = "corrupt";

    await expect(consumeApprovedConfirmationIntent({
      ...base,
      turnId: LATER_TURN,
    })).rejects.toMatchObject({ name: "ConfirmationPayloadIntegrityError" });
    expect(db.intents[0]!.consumed_at).toBeNull();
    expect(db.intents[0]!.voided_at).toBeInstanceOf(Date);
    expect(db.audits).toContain("operator.confirmation_payload_unavailable");
  });
});
