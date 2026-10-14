import type { CallIssue, JsonRecord } from "../serviceRegistry/types.js";
import { boundedJobReference } from "./jobCodec.js";

/** The longest scheduling hint core honors from an adapter: one day. */
export const MAX_SCHEDULING_HINT_SECONDS = 86_400;

/** How one bounded adapter call ended, before its value is judged. */
export type CallResult =
  | { kind: "returned"; value: unknown }
  | { kind: "threw" }
  | { kind: "timeout" }
  | { kind: "lease_lost" };

export interface ReviewedIssue {
  code: CallIssue["code"];
  retryAfterSeconds: number | null;
}

export type StartVerdict =
  | { kind: "accepted"; job: JsonRecord; pollAfterSeconds: number | null }
  | { kind: "terminal"; result: unknown }
  | { kind: "ambiguous"; issue: ReviewedIssue };

export type RecoveryVerdict =
  | { kind: "accepted"; job: JsonRecord; pollAfterSeconds: number | null }
  | { kind: "terminal"; result: unknown }
  | { kind: "safe-to-start"; basis: "authoritative-absence" | "idempotent-replay" }
  | { kind: "unknown"; issue: ReviewedIssue | null; retryAfterSeconds: number | null };

export type PollVerdict =
  | { kind: "pending"; pollAfterSeconds: number | null }
  | { kind: "terminal"; result: unknown }
  | { kind: "retry"; issue: ReviewedIssue };

const ISSUE_CODES: ReadonlySet<string> = new Set([
  "timeout", "rate_limited", "upstream_unavailable", "invalid_response", "adapter_fault",
]);

class Invalid extends Error {}

const keysOf = (value: Record<string, unknown>) => Object.keys(value).sort().join(",");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid();
  return value as Record<string, unknown>;
}

/** An optional whole-second hint from 0 to one day; anything else makes the outcome invalid. */
function hint(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SCHEDULING_HINT_SECONDS) {
    throw new Invalid();
  }
  return value as number;
}

function issue(value: unknown): ReviewedIssue {
  const fields = record(value);
  if (!["code", "code,retryAfterSeconds"].includes(keysOf(fields)) || !ISSUE_CODES.has(String(fields.code))) {
    throw new Invalid();
  }
  return { code: fields.code as CallIssue["code"], retryAfterSeconds: hint(fields.retryAfterSeconds) };
}

/** A known start outcome (accepted with a bounded reference, or terminal), else null. */
function known(fields: Record<string, unknown>): StartVerdict | null {
  if (fields.kind === "accepted" && ["job,kind", "job,kind,pollAfterSeconds"].includes(keysOf(fields))) {
    const job = boundedJobReference(fields.job);
    if (!job) throw new Invalid();
    return { kind: "accepted", job, pollAfterSeconds: hint(fields.pollAfterSeconds) };
  }
  if (fields.kind === "terminal" && keysOf(fields) === "kind,result") {
    return { kind: "terminal", result: fields.result };
  }
  return null;
}

const failure = (code: CallIssue["code"]): ReviewedIssue => ({ code, retryAfterSeconds: null });

/** The issue a call that did not return carries: a timeout, or an adapter fault for a throw. */
const callIssue = (call: CallResult): ReviewedIssue => failure(call.kind === "timeout" ? "timeout" : "adapter_fault");

/**
 * `start` outcomes: any throw, abort, timeout or invalid return is
 * ambiguous, whatever an exception says; only a known outcome moves on.
 */
export function startVerdict(call: CallResult): StartVerdict {
  if (call.kind !== "returned") return { kind: "ambiguous", issue: callIssue(call) };
  try {
    const fields = record(call.value);
    const outcome = known(fields);
    if (outcome) return outcome;
    if (fields.kind === "ambiguous" && keysOf(fields) === "issue,kind") {
      return { kind: "ambiguous", issue: issue(fields.issue) };
    }
  } catch {
    // An invalid return proves nothing about the start.
  }
  return { kind: "ambiguous", issue: failure("invalid_response") };
}

/** `recoverStart` outcomes: a throw or an invalid return is unknown. */
export function recoveryVerdict(call: CallResult): RecoveryVerdict {
  if (call.kind !== "returned") return { kind: "unknown", issue: callIssue(call), retryAfterSeconds: null };
  try {
    const fields = record(call.value);
    const outcome = known(fields);
    if (outcome) return outcome as RecoveryVerdict;
    if (fields.kind === "safe-to-start" && keysOf(fields) === "basis,kind"
      && (fields.basis === "authoritative-absence" || fields.basis === "idempotent-replay")) {
      return { kind: "safe-to-start", basis: fields.basis };
    }
    if (fields.kind === "unknown" && ["kind", "issue,kind", "kind,retryAfterSeconds", "issue,kind,retryAfterSeconds"]
      .includes(keysOf(fields))) {
      return {
        kind: "unknown",
        issue: fields.issue === undefined ? null : issue(fields.issue),
        retryAfterSeconds: hint(fields.retryAfterSeconds),
      };
    }
  } catch {
    // Fall through: an invalid return is unknown.
  }
  return { kind: "unknown", issue: failure("invalid_response"), retryAfterSeconds: null };
}

/** `poll` outcomes: a throw or an invalid return is a retry. */
export function pollVerdict(call: CallResult): PollVerdict {
  if (call.kind !== "returned") return { kind: "retry", issue: callIssue(call) };
  try {
    const fields = record(call.value);
    if (fields.kind === "pending" && ["kind", "kind,pollAfterSeconds"].includes(keysOf(fields))) {
      return { kind: "pending", pollAfterSeconds: hint(fields.pollAfterSeconds) };
    }
    if (fields.kind === "terminal" && keysOf(fields) === "kind,result") {
      return { kind: "terminal", result: fields.result };
    }
    if (fields.kind === "retry" && keysOf(fields) === "issue,kind") {
      return { kind: "retry", issue: issue(fields.issue) };
    }
  } catch {
    // Fall through: an invalid return is a retry.
  }
  return { kind: "retry", issue: failure("invalid_response") };
}
