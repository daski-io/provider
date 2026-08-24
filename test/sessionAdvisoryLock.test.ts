import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  withSessionAdvisoryLock,
  type AdvisoryAcquireResult,
} from "../src/core/db/sessionAdvisoryLock.js";

const h = {
  release: vi.fn(),
  acquire: vi.fn<() => Promise<AdvisoryAcquireResult>>(),
  unlock: vi.fn<() => Promise<boolean>>(),
  work: vi.fn<() => Promise<unknown>>(),
};

// A real EventEmitter, like pg's Client: emitting 'error' with no listener
// attached THROWS — the same semantics that turn a server-side FATAL into a
// process crash in production.
let client: PoolClient & EventEmitter;

function run() {
  return withSessionAdvisoryLock({
    connect: async () => client,
    acquire: h.acquire,
    unlock: h.unlock,
    work: h.work,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const emitter = new EventEmitter();
  (emitter as unknown as { release: unknown }).release = h.release;
  client = emitter as unknown as PoolClient & EventEmitter;
  h.acquire.mockResolvedValue({ status: "acquired" });
  h.unlock.mockResolvedValue(true);
  h.work.mockResolvedValue("complete");
});

describe("session advisory lock lifecycle", () => {
  it("normally releases a definitive clean miss without running work", async () => {
    h.acquire.mockResolvedValue({ status: "busy", session: "clean" });

    await expect(run()).resolves.toEqual({ status: "busy" });
    expect(h.work).not.toHaveBeenCalled();
    expect(h.unlock).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("destroys an uncertain busy session before returning busy", async () => {
    h.acquire.mockResolvedValue({ status: "busy", session: "uncertain" });

    await expect(run()).resolves.toEqual({ status: "busy" });
    expect(h.work).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("destroys the session when acquisition throws or is malformed", async () => {
    const acquireError = new Error("acquire failed");
    h.acquire.mockRejectedValueOnce(acquireError);
    await expect(run()).rejects.toBe(acquireError);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);

    vi.clearAllMocks();
    h.acquire.mockResolvedValueOnce("invalid" as never);
    await expect(run()).rejects.toThrow("invalid result");
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("returns work success after a confirmed unlock", async () => {
    await expect(run()).resolves.toEqual({
      status: "completed",
      value: "complete",
    });
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("preserves work failure after a confirmed unlock", async () => {
    const workError = new Error("work failed");
    h.work.mockRejectedValue(workError);

    await expect(run()).rejects.toBe(workError);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([
    ["unlock rejection", () => h.unlock.mockRejectedValue(new Error("unlock failed"))],
    ["false unlock", () => h.unlock.mockResolvedValue(false)],
  ] as const)("preserves work success after %s and destroys the session", async (_label, arrange) => {
    arrange();

    await expect(run()).resolves.toEqual({
      status: "completed",
      value: "complete",
    });
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("preserves work failure when unlock and destructive release also fail", async () => {
    const workError = new Error("work failed");
    h.work.mockRejectedValue(workError);
    h.unlock.mockRejectedValue(new Error("unlock failed"));
    h.release.mockImplementationOnce(() => {
      throw new Error("release failed");
    });

    await expect(run()).rejects.toBe(workError);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("survives a backend termination while the protected work is parked", async () => {
    // The security:postgres cleanup test's exact shape: the lease callback
    // parks with no query in flight, pg_terminate_backend kills the
    // session, and the FATAL arrives as a client-level 'error' event.
    // Before the checked-out listener existed, this emit was unhandled and
    // took down the process (PR #18 run 30660760978, red 3×).
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    h.work.mockImplementation(async () => {
      await gate;
      return "completed";
    });
    h.unlock.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );

    const lease = run();
    await vi.waitFor(() => expect(h.work).toHaveBeenCalled());
    expect(client.listenerCount("error")).toBe(1);
    client.emit(
      "error",
      Object.assign(
        new Error("terminating connection due to administrator command"),
        { code: "57P01" },
      ),
    );
    releaseWork();

    await expect(lease).resolves.toEqual({
      status: "completed",
      value: "completed",
    });
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("destroys the session on a connection error even when unlock reports success", async () => {
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    h.work.mockImplementation(async () => {
      await gate;
      return "completed";
    });

    const lease = run();
    await vi.waitFor(() => expect(h.work).toHaveBeenCalled());
    client.emit("error", new Error("connection reset"));
    releaseWork();

    await expect(lease).resolves.toEqual({
      status: "completed",
      value: "completed",
    });
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not release when connecting fails", async () => {
    const connectError = new Error("connect failed");
    await expect(
      withSessionAdvisoryLock({
        connect: async () => {
          throw connectError;
        },
        acquire: h.acquire,
        unlock: h.unlock,
        work: h.work,
      }),
    ).rejects.toBe(connectError);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});
