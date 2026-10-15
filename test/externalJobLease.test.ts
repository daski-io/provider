import { afterEach, describe, expect, it, vi } from "vitest";
import { holdJobLease, type ClaimedJob } from "../src/core/externalJobs/jobClaims.js";

const claimed = (leaseValidUntil: number) => ({ taskId: "task-lease", leaseValidUntil }) as ClaimedJob;
const clock = () => Date.now();

// L06: a holder counts on its lease only as long as it can prove it from its
// own monotonic clock, so it stops waiting on a call before any other worker
// could take the job over, whether renewals fail, stall or are refused.
describe("external-job lease holding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up an unrenewed lease one renewal interval before it could expire", async () => {
    vi.useFakeTimers({ now: 0 });
    const warnings: string[] = [];
    // Every renewal fails (a pool or statement timeout): nothing confirms the lease.
    const lease = holdJobLease(claimed(90_000), { leaseSeconds: 90, leaseRenewMs: 20_000 }, (message) => {
      warnings.push(message);
    }, { clock, renew: () => Promise.reject(new Error("timeout")) });
    expect(lease.covers(30_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    // Exactly a 30-second call and one renewal interval left, then less.
    expect(lease.covers(30_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(lease.covers(30_000)).toBe(false);
    expect(lease.lost.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(29_998);
    expect(lease.lost.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lease.lost.aborted).toBe(true);
    expect(warnings).toContain("External job lease could not be kept");
    lease.stop();
  });

  it("extends its validity from each renewal's request and gives it up at once when refused", async () => {
    vi.useFakeTimers({ now: 0 });
    let held = true;
    const lease = holdJobLease(claimed(3_000), { leaseSeconds: 3, leaseRenewMs: 500 }, () => undefined, {
      clock, renew: async () => held,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lease.lost.aborted).toBe(false);
    expect(lease.covers(1_000)).toBe(true);
    held = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(lease.lost.aborted).toBe(true);
    expect(lease.covers(1)).toBe(false);
    lease.stop();
  });

  it("counts a lease the start intent renewed from when that intent was requested", async () => {
    vi.useFakeTimers({ now: 0 });
    const lease = holdJobLease(claimed(10_000), { leaseSeconds: 90, leaseRenewMs: 20_000 }, () => undefined, {
      clock, renew: async () => true,
    });
    // Ten seconds of the claimed lease left cannot cover a 30-second call.
    expect(lease.covers(30_000)).toBe(false);
    lease.extendedFrom(Date.now());
    expect(lease.covers(30_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lease.lost.aborted).toBe(false);
    lease.stop();
    // A stopped holder arms nothing and reports nothing.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(lease.lost.aborted).toBe(false);
  });
});
