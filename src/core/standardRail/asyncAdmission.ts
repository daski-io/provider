import type { Queryable } from "../db/queryable.js";

export interface AsyncAdmissionState {
  enabled: boolean;
  changedAt: Date | null;
}

/**
 * The database-backed async-admission switch. Off unless an operator ran the
 * activation command (asyncAdmissionActivation.ts); external-job admission
 * reads it, nothing in boot, migrations or the importer writes it. An
 * unreadable switch reads as off.
 */
export async function readAsyncAdmission(db: Queryable): Promise<AsyncAdmissionState> {
  const result = await db.query<{ enabled: boolean; changed_at: Date | null }>(
    "SELECT enabled, changed_at FROM provider_async_admission WHERE singleton",
  );
  const row = result.rows[0];
  return { enabled: row?.enabled === true, changedAt: row?.changed_at ?? null };
}
