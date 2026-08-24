import type { EncryptionContext } from "../chain/encryption.js";
import {
  decryptString,
  encryptString,
  inspectEncryptionEnvelope,
  protectedLookupHash,
} from "../chain/encryption.js";
import type { Queryable } from "../db/queryable.js";

type Row = Record<string, unknown>;

export interface RotationBatchResult {
  lastCursor: string | null;
  examined: number;
  rotated: number;
  keyCounts: Record<string, number>;
  done: boolean;
}

export interface ProtectedDataSink {
  name: string;
  registeredColumns: string[];
  processBatch(args: {
    db: Queryable;
    after: string | null;
    limit: number;
    fromKeyId?: string;
  }): Promise<RotationBatchResult>;
}

export interface DirectField {
  column: string;
  storage?: "text" | "json-string";
  context: (row: Row) => EncryptionContext;
  lookup?: { column: string; purpose: string; normalize?: (value: string) => string };
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier ${value}`);
  return value;
}

function mergeCount(counts: Record<string, number>, value: string): void {
  const keyId = inspectEncryptionEnvelope(value).keyId;
  counts[keyId] = (counts[keyId] ?? 0) + 1;
}

export function createDirectSink(args: {
  name: string;
  table: string;
  cursorColumn: string;
  fields: DirectField[];
}): ProtectedDataSink {
  const table = assertIdentifier(args.table);
  const cursor = assertIdentifier(args.cursorColumn);
  const fields = args.fields.map((field) => ({
    ...field,
    column: assertIdentifier(field.column),
  }));
  const predicates = fields.map((field) => field.storage === "json-string"
    ? `(jsonb_typeof(${field.column}) = 'string' AND ${field.column} #>> '{}' LIKE 'daski:v1:%')`
    : `${field.column} LIKE 'daski:v1:%'`);
  return {
    name: args.name,
    registeredColumns: fields.map((field) => `${table}.${field.column}`),
    async processBatch({ db, after, limit, fromKeyId }) {
      const result = await db.query<Row>(
        `SELECT * FROM ${table}
          WHERE ($1::text IS NULL OR ${cursor}::text > $1)
            AND (${predicates.join(" OR ")})
          ORDER BY ${cursor}::text
          LIMIT $2`,
        [after, limit],
      );
      const keyCounts: Record<string, number> = {};
      let rotated = 0;
      for (const row of result.rows) {
        for (const field of fields) {
          const raw = row[field.column];
          if (typeof raw !== "string" || !raw.startsWith("daski:v1:")) continue;
          mergeCount(keyCounts, raw);
          if (!fromKeyId || inspectEncryptionEnvelope(raw).keyId !== fromKeyId) continue;
          const plaintext = decryptString(raw, field.context(row));
          const replacement = encryptString(plaintext, field.context(row));
          const storedReplacement = field.storage === "json-string"
            ? JSON.stringify(replacement)
            : replacement;
          const storedRaw = field.storage === "json-string" ? JSON.stringify(raw) : raw;
          const lookupSql = field.lookup ? `, ${assertIdentifier(field.lookup.column)} = $4` : "";
          const update = await db.query(
            `UPDATE ${table} SET ${field.column} = $3${field.storage === "json-string" ? "::jsonb" : ""}${lookupSql}
              WHERE ${cursor}::text = $1
                AND ${field.column} IS NOT DISTINCT FROM $2${field.storage === "json-string" ? "::jsonb" : ""}`,
            field.lookup
              ? [
                  String(row[args.cursorColumn]),
                  storedRaw,
                  storedReplacement,
                  protectedLookupHash(
                    field.lookup.normalize?.(plaintext) ?? plaintext,
                    field.lookup.purpose,
                  ),
                ]
              : [String(row[args.cursorColumn]), storedRaw, storedReplacement],
          );
          if (update.rowCount !== 1) throw new Error(`${args.name} rotation lost a concurrent update`);
          row[field.column] = replacement;
          rotated += 1;
        }
      }
      return {
        lastCursor: result.rows.length
          ? String(result.rows[result.rows.length - 1][args.cursorColumn])
          : after,
        examined: result.rows.length,
        rotated,
        keyCounts,
        done: result.rows.length < limit,
      };
    },
  };
}

export interface JsonEnvelopeCell {
  path: string[];
  value: string;
  context: EncryptionContext;
}

function setPath(value: Record<string, unknown>, path: string[], replacement: string): void {
  let cursor: Record<string, unknown> = value;
  for (const part of path.slice(0, -1)) {
    const child = cursor[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      throw new Error(`protected JSON path disappeared: ${path.join(".")}`);
    }
    cursor = child as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = replacement;
}

export function createJsonSink(args: {
  name: string;
  table: string;
  cursorColumn: string;
  column: string;
  cells: (row: Row, json: Record<string, unknown>) => JsonEnvelopeCell[];
}): ProtectedDataSink {
  const table = assertIdentifier(args.table);
  const cursor = assertIdentifier(args.cursorColumn);
  const column = assertIdentifier(args.column);
  return {
    name: args.name,
    registeredColumns: [`${table}.${column}`],
    async processBatch({ db, after, limit, fromKeyId }) {
      const result = await db.query<Row>(
        `SELECT * FROM ${table}
          WHERE ($1::text IS NULL OR ${cursor}::text > $1)
            AND ${column}::text LIKE '%daski:v1:%'
          ORDER BY ${cursor}::text LIMIT $2`,
        [after, limit],
      );
      const keyCounts: Record<string, number> = {};
      let rotated = 0;
      for (const row of result.rows) {
        const original = row[column] as Record<string, unknown>;
        const replacement = structuredClone(original);
        for (const cell of args.cells(row, replacement)) {
          mergeCount(keyCounts, cell.value);
          if (!fromKeyId || inspectEncryptionEnvelope(cell.value).keyId !== fromKeyId) continue;
          const plaintext = decryptString(cell.value, cell.context);
          setPath(replacement, cell.path, encryptString(plaintext, cell.context));
          rotated += 1;
        }
        if (JSON.stringify(replacement) === JSON.stringify(original)) continue;
        const updated = await db.query(
          `UPDATE ${table} SET ${column} = $3::jsonb
            WHERE ${cursor}::text = $1 AND ${column} = $2::jsonb`,
          [String(row[args.cursorColumn]), JSON.stringify(original), JSON.stringify(replacement)],
        );
        if (updated.rowCount !== 1) throw new Error(`${args.name} rotation lost a concurrent update`);
      }
      return {
        lastCursor: result.rows.length
          ? String(result.rows[result.rows.length - 1][args.cursorColumn])
          : after,
        examined: result.rows.length,
        rotated,
        keyCounts,
        done: result.rows.length < limit,
      };
    },
  };
}

// ── Shared field-builder helpers ──────────────────────────────────────
// Used by core's sink declarations and by every service's
// `ServiceModule.security.protectedDataSinks` contribution.

/** Stringify a row column for use in an encryption context. */
export function sinkText(row: Row, key: string): string {
  return String(row[key]);
}

/** Build the per-cell encryption context for a sink field. */
export function sinkContext(
  purpose: string,
  table: string,
  recordId: string,
  field: string,
  extra: Partial<EncryptionContext> = {},
): EncryptionContext {
  return { purpose, table, recordId, field, ...extra };
}

/** Extract a `daski:v1:` envelope at a JSON path (empty when absent). */
export function envelopeAt(
  json: Record<string, unknown>,
  path: string[],
  encryptionContext: EncryptionContext,
): JsonEnvelopeCell[] {
  let value: unknown = json;
  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" && value.startsWith("daski:v1:")
    ? [{ path, value, context: encryptionContext }]
    : [];
}
