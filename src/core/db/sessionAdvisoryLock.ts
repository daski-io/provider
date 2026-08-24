import type { PoolClient } from "pg";

export type AdvisoryAcquireResult =
  | { status: "acquired" }
  | { status: "busy"; session: "clean" | "uncertain" };

export type SessionAdvisoryLockResult<T> =
  | { status: "completed"; value: T }
  | { status: "busy" };

export interface SessionAdvisoryLockOptions<T> {
  connect: () => Promise<PoolClient>;
  acquire: (client: PoolClient) => Promise<AdvisoryAcquireResult>;
  unlock: (client: PoolClient) => Promise<boolean>;
  work: (client: PoolClient) => Promise<T>;
}

function releaseClient(client: PoolClient, destroy: boolean): void {
  try {
    client.release(destroy);
  } catch {
    // Pool cleanup must not replace the protected operation's outcome.
  }
}

/**
 * Owns the cleanup state machine for one PostgreSQL session advisory lock.
 * Callers retain their lock SQL and domain-specific busy behavior.
 */
export async function withSessionAdvisoryLock<T>(
  options: SessionAdvisoryLockOptions<T>,
): Promise<SessionAdvisoryLockResult<T>> {
  const client = await options.connect();
  let acquired = false;
  let destroy = true;
  let sessionLost = false;
  // A server-side termination (failover, connection reaper,
  // pg_terminate_backend) surfaces as a client-level 'error' event, and
  // node-postgres only auto-listens on IDLE pooled clients. While this
  // client is checked out with no query in flight — e.g. the protected
  // work is parked awaiting something else — an unlistened FATAL is an
  // unhandled 'error' event and kills the process. Queries in flight
  // still reject through their own promises; this listener's only jobs
  // are to keep the process alive and to force the dead session's
  // destruction on release.
  const onSessionError = (): void => {
    sessionLost = true;
  };
  client.on("error", onSessionError);

  try {
    const acquisition = await options.acquire(client);
    if (
      acquisition?.status === "busy"
      && (acquisition.session === "clean" || acquisition.session === "uncertain")
    ) {
      destroy = acquisition.session === "uncertain";
      return { status: "busy" };
    }
    if (acquisition?.status !== "acquired") {
      throw new Error("session advisory lock acquisition returned an invalid result");
    }
    acquired = true;

    let value: T | undefined;
    let workError: unknown;
    let workFailed = false;
    try {
      value = await options.work(client);
    } catch (error) {
      workFailed = true;
      workError = error;
    }

    try {
      if (await options.unlock(client) === true) {
        acquired = false;
        destroy = false;
      }
    } catch {
      // Session destruction below is the only certain unlock after an error.
    }

    if (workFailed) throw workError;
    return { status: "completed", value: value as T };
  } finally {
    client.removeListener("error", onSessionError);
    if (acquired || sessionLost) destroy = true;
    releaseClient(client, destroy);
  }
}
