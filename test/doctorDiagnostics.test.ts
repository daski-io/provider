import { describe, expect, it } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";
import { safeMessage } from "../src/core/diagnostics/checks.js";
import { externalJobsCheck } from "../src/core/diagnostics/servicingChecks.js";
import { START_JOURNAL_KIND } from "../src/core/externalJobs/journalHandoff.js";
import { CORE_START_JOURNAL_KIND } from "../src/core/standardRail/legacyCutover.js";

const servicing = { adapterVersions: () => new Set<string>(["v1"]), keyIds: new Set<string>(), canSeal: true };

/** A database whose external-job inspection finds one healthy unfinished job. */
const oneJob: Queryable = {
  query: (async (sql: string) => sql.includes("GROUP BY")
    ? { rows: [] }
    : {
      rows: [{
        active: 1, staleLeases: 0, overdue: 0, startAmbiguous: 0, resultInvalid: 0, failing: 0,
      }],
    }) as unknown as Queryable["query"],
};

// L-T20: database diagnostics never repeat a driver message, and a check
// that could not run never implies another's verdict.
describe("doctor database diagnostics", () => {
  it("names a database error by its code and redacts credentials in this build's own messages", () => {
    const driver = Object.assign(new Error("permission denied: postgresql://runtime:hunter2@db.internal/x"), {
      code: "42501",
    });
    expect(safeMessage(driver)).toBe("the database could not be read (42501)");
    const own = new Error("catalog for postgresql://runtime:hunter2@db.internal/x is incomplete");
    expect(safeMessage(own)).not.toContain("hunter2");
    expect(safeMessage(own)).toContain("<redacted>@");
  });

  it("raises a stopped worker only when the running instances were read", async () => {
    const args = { servicing, leaseSeconds: 90, gatewayAudience: "https://gateway.example" };
    expect((await externalJobsCheck(oneJob, { ...args, liveWorkers: 0 })).details?.codes)
      .toEqual(["external_job_worker_stopped"]);
    expect((await externalJobsCheck(oneJob, { ...args, liveWorkers: null })).details?.codes).toEqual([]);
    expect((await externalJobsCheck(oneJob, { ...args, liveWorkers: 1 })).status).toBe("pass");
  });

  it("excludes exactly core's own start journal from the operator's supplier work", () => {
    expect(CORE_START_JOURNAL_KIND).toBe(START_JOURNAL_KIND);
  });
});
