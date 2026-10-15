import type { MigrationFile } from "../db/migrationFiles.js";
import type { Queryable } from "../db/queryable.js";
import type { ProviderStandardRailConfig } from "../standardRail/config.js";
import { cutoverInventory } from "../standardRail/legacyCutover.js";
import { verifyRetainedObligations, type ExternalJobServicing } from "../standardRail/retainedObligations.js";
import {
  check,
  counted,
  MAX_LISTED_REFERENCES,
  migrationsCheck,
  safeMessage,
  schemaEpochCheck,
  type DiagnosticCheck,
} from "./checks.js";
import { databaseErrorCode, inSavepoint } from "./readOnlySession.js";
import {
  asyncAdmissionCheck,
  executionChecks,
  externalJobsCheck,
  runtimeInstancesCheck,
} from "./servicingChecks.js";

export type { DiagnosticCheck, DiagnosticStatus } from "./checks.js";

/** What this build is, as its configuration and composition declare it. */
export interface DatabaseDiagnosticsInput {
  migrations: readonly MigrationFile[];
  /** The adapter versions and encryption key ids this build can service. */
  servicing: ExternalJobServicing;
  /** Slugs of the installed external-job services. */
  externalJobServices: readonly string[];
  /** The installed paid skills, which the runtime catalog must list. */
  paidSkills: readonly { serviceSlug: string; skillId: string }[];
  leaseSeconds: number;
  gatewayAudience: string;
  /** Loads the standard-rail configuration, its runtime catalog read through this snapshot. */
  standardRail(db: Queryable): Promise<ProviderStandardRailConfig>;
}

/** Checks that need this build's schema; reported as not performed without it. */
const CATALOG_CODES = ["RUNTIME_CATALOG", "RETAINED_OBLIGATIONS"] as const;
const SCHEMA_DEPENDENT = [
  "ASYNC_ADMISSION", "RUNTIME_INSTANCES", "LEGACY_EXECUTIONS", "SYNC_EXECUTION_LEASES",
  "SUPPLIER_OPERATIONS", "EXTERNAL_JOBS", ...CATALOG_CODES,
] as const;

const notPerformed = (code: string, reason: string) =>
  check(code, "skip", `Not performed: ${reason}.`, "Resolve DATABASE_SCHEMA_EPOCH first.");

async function guarded(codes: readonly string[], work: () => Promise<DiagnosticCheck[]>): Promise<DiagnosticCheck[]> {
  return work().catch((error) => codes.map((code) =>
    check(code, "fail", `The check could not be completed (${databaseErrorCode(error)}).`)));
}

/**
 * The installed runtime catalog against this build's paid skills, and the
 * retained obligations, judged exactly as boot and the importer judge them.
 */
async function catalogChecks(db: Queryable, input: DatabaseDiagnosticsInput): Promise<DiagnosticCheck[]> {
  let standard: ProviderStandardRailConfig;
  try {
    standard = await inSavepoint(db, () => input.standardRail(db));
  } catch (error) {
    const message = safeMessage(error);
    if (/ is required for the standard rail$/.test(message)) {
      return CATALOG_CODES.map((code) => check(code, "skip", `Not performed: ${message}.`,
        "Configure the Daski-issued standard-rail values (docs/configuration.md) to judge the catalog."));
    }
    return CATALOG_CODES.map((code) => check(code, "fail",
      `The standard-rail configuration or runtime catalog does not load: ${message}.`,
      "Boot refuses the same configuration; correct it rather than the catalog."));
  }
  const heads = new Set([...standard.outcomes.values()].map((outcome) => `${outcome.serviceSlug}:${outcome.skillId}`));
  const unlisted = input.paidSkills.map((skill) => `${skill.serviceSlug}:${skill.skillId}`)
    .filter((skill) => !heads.has(skill));
  const details = {
    heads: standard.outcomes.size,
    installedVersions: standard.servicing.size + standard.unserviceable.size,
    unserviceableVersions: standard.unserviceable.size,
    unlistedPaidSkills: unlisted.slice(0, MAX_LISTED_REFERENCES),
  };
  const catalog = unlisted.length > 0
    ? check("RUNTIME_CATALOG", "warn",
      `${counted(unlisted.length, "installed paid skill has", "installed paid skills have")} no promoted runtime listing and cannot be bought yet.`,
      "Install the Daski-issued bundle: npm run daski:install-runtime -- --file <path>.", details)
    : check("RUNTIME_CATALOG", "pass",
      `Every installed paid skill has a promoted runtime listing (${counted(standard.outcomes.size, "head")}).`,
      undefined, details);
  try {
    await inSavepoint(db, () => verifyRetainedObligations(db, standard, input.servicing));
  } catch (error) {
    return [catalog, check("RETAINED_OBLIGATIONS", "fail", `${safeMessage(error)}.`,
      "See docs/troubleshooting.md; never delete claims or quotes to pass this check.")];
  }
  return [catalog, check("RETAINED_OBLIGATIONS", "pass",
    "This build can service every claim, open quote and unfinished external job it would take over.")];
}

/**
 * The doctor's database checks over one read-only snapshot: the schema
 * epoch and barrier, the migration ledger, the async-admission switch,
 * running instances and their workers, pre-R1 executions, synchronous
 * leases, unresolved supplier mutations, unfinished external jobs, the
 * runtime catalog and retained obligations. Each reports counts and opaque references only.
 * Every statement is a SELECT (or a savepoint of the read-only transaction).
 */
export async function runDatabaseDiagnostics(db: Queryable, input: DatabaseDiagnosticsInput): Promise<DiagnosticCheck[]> {
  const schema = await schemaEpochCheck(db);
  const checks: DiagnosticCheck[] = [schema.check];
  checks.push(schema.providerSchema
    ? await migrationsCheck(db, input.migrations)
    : notPerformed("DATABASE_MIGRATIONS", "the database has no provider schema"));
  if (!schema.atBuildEpoch) {
    const reason = schema.providerSchema
      ? "the database schema is not exactly this build's"
      : "the database has no provider schema";
    return [...checks, ...SCHEMA_DEPENDENT.map((code) => notPerformed(code, reason))];
  }
  checks.push(...await guarded(["ASYNC_ADMISSION"], async () =>
    [await inSavepoint(db, () => asyncAdmissionCheck(db, input.externalJobServices))]));
  let liveWorkers = 0;
  checks.push(...await guarded(["RUNTIME_INSTANCES"], async () => {
    const instances = await inSavepoint(db, () => runtimeInstancesCheck(db));
    liveWorkers = instances.liveWorkers;
    return [instances.check];
  }));
  checks.push(...await guarded(["LEGACY_EXECUTIONS", "SYNC_EXECUTION_LEASES", "SUPPLIER_OPERATIONS"], async () =>
    executionChecks(await inSavepoint(db, () => cutoverInventory(db)))));
  checks.push(...await guarded(["EXTERNAL_JOBS"], async () => [await inSavepoint(db, () => externalJobsCheck(db, {
    servicing: input.servicing,
    leaseSeconds: input.leaseSeconds,
    gatewayAudience: input.gatewayAudience,
    liveWorkers,
  }))]));
  checks.push(...await catalogChecks(db, input));
  return checks;
}
