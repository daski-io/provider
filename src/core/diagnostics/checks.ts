import type { MigrationFile } from "../db/migrationFiles.js";
import type { Queryable } from "../db/queryable.js";
import {
  readDatabaseSchemaEpoch,
  RUNTIME_SCHEMA_EPOCH,
  verifyCompatibilityBarrier,
} from "../db/runtimeEpoch.js";
import { RUNTIME_TABLE_PRIVILEGES } from "../db/runtimePrivileges.js";
import { redactSensitiveText } from "../security/redaction.js";
import { databaseErrorCode, inSavepoint } from "./readOnlySession.js";

/** `skip` means the check was not performed, which is never a pass. */
export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";

/** One doctor check: a stable code, counts and opaque references only. */
export interface DiagnosticCheck {
  code: string;
  status: DiagnosticStatus;
  message: string;
  remedy?: string;
  details?: Record<string, unknown>;
}

export const check = (
  code: string,
  status: DiagnosticStatus,
  message: string,
  remedy?: string,
  details?: Record<string, unknown>,
): DiagnosticCheck => ({ code, status, message, ...(remedy ? { remedy } : {}), ...(details ? { details } : {}) });

/**
 * A thrown message a diagnostic may show. A database or network error is
 * named by its code only (a driver message can quote values, hosts or
 * URLs); this build's own wording is redacted, credentials in any URL
 * scheme included, and bounded.
 */
export function safeMessage(error: unknown): string {
  if (databaseErrorCode(error) !== "unknown") return `the database could not be read (${databaseErrorCode(error)})`;
  const text = error instanceof Error ? error.message : "check failed";
  return redactSensitiveText(text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1<redacted>@")).slice(0, 500);
}

/** "1 job", "2 jobs". */
export const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

/** Opaque references in a report are bounded. */
export const MAX_LISTED_REFERENCES = 10;

export interface SchemaState {
  check: DiagnosticCheck;
  /** True only when the schema is exactly this build's epoch with its barrier intact. */
  atBuildEpoch: boolean;
  /** Whether any provider schema exists (the ledger can then be compared). */
  providerSchema: boolean;
}

/**
 * The schema epoch the database declares, against this build's, and the
 * legacy-process barrier this build relies on (migration 005).
 */
export async function schemaEpochCheck(db: Queryable): Promise<SchemaState> {
  const code = "DATABASE_SCHEMA_EPOCH";
  const present = await inSavepoint(db, () => db.query<{ present: boolean }>(
    "SELECT to_regclass('provider_transactions') IS NOT NULL AS present",
  ));
  if (!present.rows[0]?.present) {
    return {
      providerSchema: false,
      atBuildEpoch: false,
      check: check(code, "fail", "The database has no provider schema; no build has migrated it.",
        "Start this build, which migrates; for a database a pre-R1 image used, run npm run daski:cutover."),
    };
  }
  let epoch: number;
  try {
    epoch = await inSavepoint(db, () => readDatabaseSchemaEpoch(db));
  } catch (error) {
    return {
      providerSchema: true,
      atBuildEpoch: false,
      check: check(code, "fail", `The schema epoch could not be read (${databaseErrorCode(error)}).`,
        "Restore provider_schema_epoch from migration 005; never boot without it."),
    };
  }
  const details = { databaseEpoch: epoch, buildEpoch: RUNTIME_SCHEMA_EPOCH };
  if (epoch !== RUNTIME_SCHEMA_EPOCH) {
    const remedy = epoch === 0
      ? "Follow the stop-and-drain cutover in docs/onboarding.md (npm run daski:cutover)."
      : epoch > RUNTIME_SCHEMA_EPOCH
        ? "Run a build that supports this epoch; never lower it."
        : "Start this build, which migrates the schema to its epoch.";
    const message = epoch === 0
      ? "The database is at schema epoch 0: the pre-R1 schema, without the legacy-process barrier."
      : `The database is at schema epoch ${epoch}; this build supports exactly ${RUNTIME_SCHEMA_EPOCH}.`;
    return { providerSchema: true, atBuildEpoch: false, check: check(code, "fail", message, remedy, details) };
  }
  try {
    await inSavepoint(db, () => verifyCompatibilityBarrier(db, Object.keys(RUNTIME_TABLE_PRIVILEGES)));
  } catch (error) {
    return {
      providerSchema: true,
      atBuildEpoch: false,
      check: check(code, "fail", `The legacy-process barrier is not intact: ${safeMessage(error)}.`,
        "Restore it from migration 005 (see docs/troubleshooting.md); never boot with it removed.", details),
    };
  }
  return {
    providerSchema: true,
    atBuildEpoch: true,
    check: check(code, "pass",
      `Schema epoch ${epoch} is this build's and the legacy-process barrier is installed.`, undefined, details),
  };
}

/** The migration ledger against this build's files: pending, unknown and changed migrations. */
export async function migrationsCheck(db: Queryable, migrations: readonly MigrationFile[]): Promise<DiagnosticCheck> {
  const code = "DATABASE_MIGRATIONS";
  let applied: Array<{ name: string; checksum: string }>;
  try {
    applied = (await inSavepoint(db, () => db.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM _migrations ORDER BY name",
    ))).rows;
  } catch (error) {
    const sqlState = databaseErrorCode(error);
    if (sqlState === "42501") {
      return check(code, "skip",
        "Not performed: this database role cannot read the migration ledger (a separate runtime principal never can).",
        "Boot verifies every applied checksum; run the doctor as the schema owner to compare them here.");
    }
    if (sqlState === "42P01") {
      return check(code, "fail", "The database has no migration ledger.", "Start this build, which migrates.");
    }
    return check(code, "fail", `The migration ledger could not be read (${sqlState}).`);
  }
  const built = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  const recorded = new Map(applied.map((row) => [row.name, row.checksum]));
  const pending = migrations.filter((migration) => !recorded.has(migration.name)).map((migration) => migration.name);
  const unknown = applied.filter((row) => !built.has(row.name)).map((row) => row.name);
  const changed = applied.filter((row) => built.has(row.name) && built.get(row.name) !== row.checksum)
    .map((row) => row.name);
  const details = { applied: applied.length, built: migrations.length, pending, unknown, changed };
  if (unknown.length > 0 || changed.length > 0) {
    return check(code, "fail", unknown.length > 0
      ? `The ledger records ${counted(unknown.length, "migration")} this build does not ship: a newer build migrated it.`
      : `${counted(changed.length, "applied migration differs", "applied migrations differ")} from this build's files.`,
    "Never edit an applied migration or run an older build against a newer schema; roll forward.", details);
  }
  if (pending.length > 0) {
    return check(code, "warn", `${counted(pending.length, "migration")} of this build ${pending.length === 1 ? "is" : "are"} not applied yet.`,
      "They are applied by this build's boot, the importer or npm run daski:cutover; the doctor never migrates.",
      details);
  }
  return check(code, "pass", `All ${migrations.length} migrations of this build are applied with matching checksums.`,
    undefined, details);
}
