import { randomUUID } from "node:crypto";
import { decryptString, encryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { redactSensitiveText } from "../security/redaction.js";

export type LegalHoldScope = "transaction" | "asset" | "compliance_case";

export interface LegalHoldRow {
  id: string;
  scope_type: LegalHoldScope;
  scope_id: string;
  reason: string;
  placed_by: string;
  placed_at: Date;
  released_by: string | null;
  released_at: Date | null;
}

function holdContext(id: string) {
  return {
    purpose: "legal-hold",
    table: "legal_holds",
    recordId: id,
    field: "reason",
    service: "core",
  } as const;
}

function reveal(row: LegalHoldRow): LegalHoldRow {
  return { ...row, reason: decryptString(row.reason, holdContext(row.id)) };
}

function safeReason(value: string): string {
  const reason = redactSensitiveText(value.trim());
  if (reason.length < 8 || reason.length > 2_048) {
    throw new Error("legal-hold reason must be between 8 and 2048 characters");
  }
  return reason;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function placeLegalHold(args: {
  scopeType: LegalHoldScope;
  scopeId: string;
  reason: string;
  actor: string;
}): Promise<{ hold: LegalHoldRow; created: boolean }> {
  if (!["transaction", "asset", "compliance_case"].includes(args.scopeType)) {
    throw new Error("invalid legal-hold scope type");
  }
  if (!args.scopeId || args.scopeId.length > 256) throw new Error("invalid legal-hold scope id");
  if (args.scopeType !== "transaction" && !UUID_RE.test(args.scopeId)) {
    throw new Error(`${args.scopeType} legal-hold scope must be a UUID`);
  }
  const reason = safeReason(args.reason);
  return inTransaction(pool, async (db) => {
    const targetTable = {
      transaction: "transactions",
      asset: "assets",
      compliance_case: "compliance_cases",
    }[args.scopeType];
    const target = await db.query(
      `SELECT 1 FROM ${targetTable} WHERE id::text = $1`,
      [args.scopeId],
    );
    if (target.rowCount !== 1) throw new Error(`${args.scopeType} legal-hold target not found`);
    const id = randomUUID();
    const inserted = await db.query<LegalHoldRow>(
      `INSERT INTO legal_holds(id, scope_type, scope_id, reason, placed_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (scope_type, scope_id) WHERE released_at IS NULL DO NOTHING
       RETURNING *`,
      [id, args.scopeType, args.scopeId, encryptString(reason, holdContext(id)), args.actor],
    );
    const stored = inserted.rows[0] ?? (await db.query<LegalHoldRow>(
      `SELECT * FROM legal_holds
        WHERE scope_type = $1 AND scope_id = $2 AND released_at IS NULL
        FOR UPDATE`,
      [args.scopeType, args.scopeId],
    )).rows[0];
    if (!stored) throw new Error("legal hold could not be placed");
    if (inserted.rows[0]) {
      await recordMandatoryAudit(db, {
        source: "admin",
        severity: "warn",
        type: "admin.legal_hold.placed",
        actor: args.actor,
        message: `Legal hold ${stored.id} placed on ${args.scopeType}.`,
        payload: { holdId: stored.id, scopeType: args.scopeType, scopeId: args.scopeId },
      });
    }
    return { hold: reveal(stored), created: Boolean(inserted.rows[0]) };
  });
}

export async function releaseLegalHold(id: string, actor: string): Promise<LegalHoldRow> {
  return inTransaction(pool, async (db) => {
    const released = await db.query<LegalHoldRow>(
      `UPDATE legal_holds SET released_at = now(), released_by = $2
        WHERE id = $1 AND released_at IS NULL RETURNING *`,
      [id, actor],
    );
    const hold = released.rows[0];
    if (!hold) throw new Error("active legal hold not found");
    await recordMandatoryAudit(db, {
      source: "admin",
      severity: "warn",
      type: "admin.legal_hold.released",
      actor,
      message: `Legal hold ${id} released; normal retention resumes.`,
      payload: { holdId: id, scopeType: hold.scope_type, scopeId: hold.scope_id },
    });
    return reveal(hold);
  });
}

export async function listActiveLegalHolds(): Promise<LegalHoldRow[]> {
  const result = await pool.query<LegalHoldRow>(
    `SELECT * FROM legal_holds WHERE released_at IS NULL ORDER BY placed_at DESC`,
  );
  return result.rows.map(reveal);
}
