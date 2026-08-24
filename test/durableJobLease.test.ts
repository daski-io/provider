import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), inTransaction: vi.fn() }));

vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/db/queryable.js", () => ({ inTransaction: h.inTransaction }));

import {
  claimDurableJob,
  completeDurableJob,
  failDurableJob,
  renewDurableJobLease,
  withDurableJobLease,
} from "../src/core/db/queries/durableJobs.js";

beforeEach(() => {
  vi.useFakeTimers();
  h.query.mockReset();
  h.inTransaction.mockReset();
  h.query.mockResolvedValue({ rowCount: 1, rows: [] });
});

afterEach(() => vi.useRealTimers());

describe("durable job lease heartbeat", () => {
  it("renews ownership while slow finality work is still running", async () => {
    let finish: ((value: string) => void) | undefined;
    const running = withDurableJobLease({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "claim-a",
      leaseSeconds: 3,
      work: async () => new Promise<string>((resolve) => { finish = resolve; }),
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenLastCalledWith(
      expect.stringContaining("lease_expires_at"),
      ["job-1", "replica-a", "claim-a", 3],
    );
    finish?.("complete");
    await expect(running).resolves.toBe("complete");
  });

  it("refuses completion after another replica takes ownership", async () => {
    h.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const running = withDurableJobLease({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "claim-a",
      leaseSeconds: 3,
      work: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return "unsafe-completion";
      },
    });
    const rejected = expect(running).rejects.toThrow(/Lost durable job lease/);
    await vi.advanceTimersByTimeAsync(1_100);
    await rejected;
  });

  it("rejects an earlier claim after the same worker id reclaims the job", async () => {
    h.query.mockImplementation(async (_sql: string, values: unknown[]) => ({
      rowCount: values[2] === "claim-b" ? 1 : 0,
      rows: [],
    }));

    await expect(completeDurableJob({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "claim-a",
    })).resolves.toBe(false);
    await expect(completeDurableJob({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "claim-b",
    })).resolves.toBe(true);

    expect(h.query.mock.calls[0][0]).toContain("lease_token = $3");
    expect(h.query.mock.calls[0][0]).toContain("lease_expires_at > now()");
  });

  it("requires the unexpired claim token for renew and fail", async () => {
    h.query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(renewDurableJobLease({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "expired-claim",
      leaseSeconds: 3,
    })).resolves.toBe(false);
    await expect(failDurableJob({
      id: "job-1",
      workerId: "replica-a",
      leaseToken: "expired-claim",
      error: "crashed",
      retryAt: new Date(),
    })).resolves.toBeNull();

    expect(h.query.mock.calls[0][0]).toContain("lease_token = $3");
    expect(h.query.mock.calls[0][0]).toContain("lease_expires_at > now()");
    expect(h.query.mock.calls[1][0]).toContain("lease_token = $4");
    expect(h.query.mock.calls[1][0]).toContain("lease_expires_at > now()");
  });

  it("dead-letters an expired final attempt and never exposes exhausted work", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rowCount: 0, rows: [] };
      }),
    };
    h.inTransaction.mockImplementation(async (_pool, work) => work(db));

    await expect(claimDurableJob({
      queue: "security-critical",
      workerId: "replica-a",
      leaseSeconds: 3,
    })).resolves.toBeNull();

    expect(queries[0]).toContain("WHEN attempts >= max_attempts THEN 'dead_letter'");
    expect(queries[0]).toContain("lease_token = NULL");
    expect(queries[1]).toContain("attempts >= max_attempts");
    expect(queries[2]).toContain("attempts < max_attempts");
    expect(queries[2]).toContain("lease_token = gen_random_uuid()");
  });
});
