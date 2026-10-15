# External jobs in the lite starter

Read this reference when the selected path is the lite external job, or when
deciding whether a product that runs paid work as its own job fits it. The
checked-out `provider` repository is authoritative: confirm that
`src/core/serviceRegistry/adapterTypes.ts` declares `ExternalJobAdapter`
before relying on anything here, and follow its `docs/adding-a-service.md`.

## Who does what

| Core runtime (do not rebuild it) | The service adapter (write it) |
| --- | --- |
| Verifies the signed dispatch, quote, payer, and payment evidence | Validates the buyer input again |
| Commits the claim, the queued job, and the encrypted input in one transaction and answers `submitted` (or a later persisted state); the dispatch handler never calls the product | `start`: submits the job to the product under core's key |
| Derives one stable idempotency key per order and persists it before any call | `recoverStart`: read-only lookup of the original job after an uncertain start |
| Records the start intent and the replay horizon before the first call | `poll`: read-only look at the original job |
| Leases, fencing, scheduling, backoff, restart recovery, overdue handling | Maps product states and the report to typed outcomes |
| Validates and freezes the result; signs status and artifact reads | Pins the product endpoints and validates any URL it stores |
| Runs each order with the adapter version that sold its quote, and resumes its job with that version, the keys, and the contract that admitted it | Declares its `version` and replay retention, and keeps old adapters in `previousExternalJobAdapters` while their jobs run or the quotes they sold are kept (every quote is kept) |

Never build a private polling server, hold an HTTP request open for the job,
raise the 50-second synchronous budget, sleep inside an adapter call, or copy
`provider-full`'s operator or asset subsystems into lite.

## Payment boundary

Daski already admitted the buyer's payment before the adapter runs. `start`
must create the job through a provider-owned creation operation or an
authenticated internal API, keyed by the verified order (`context.orderId`
and core's `context.idempotencyKey`). Never add a public `alreadyPaid` flag
that any caller can assert, and never pay the product's public x402 or other
paid endpoint again for an admitted order. A design in which each order needs
a separately funded upstream purchase is outside this pattern: record it as
an upstream gap.

## The typed contract

An external-job adapter declares `mode: "external-job"`, a `version` (how its
job references are read), and, when the product documents one, its
`idempotencyRetentionSeconds`. Every call receives an `ExternalJobContext`:
`taskId`, `orderId`, `payer`, `serviceSlug`, `skillId`, `idempotencyKey`,
`acceptedAt`, `fulfillmentDeadline`, `firstStartAttemptAt`,
`idempotencyValidBefore`, and a `signal` that bounds this one call, never
the whole upstream job.

| Hook | Returns |
| --- | --- |
| `start(context, input)` | `{kind: "accepted", job, pollAfterSeconds?}`, `{kind: "terminal", result}`, or `{kind: "ambiguous", issue}` |
| `recoverStart(context, input)` | the original `accepted` or `terminal` outcome, `{kind: "safe-to-start", basis: "authoritative-absence" \| "idempotent-replay"}`, or `{kind: "unknown", issue?, retryAfterSeconds?}` |
| `poll(context, job)` | `{kind: "pending", pollAfterSeconds?}`, `{kind: "terminal", result}`, or `{kind: "retry", issue}` |

An `issue` is `{code, retryAfterSeconds?}` with `code` one of `timeout`,
`rate_limited`, `upstream_unavailable`, `invalid_response`, or
`adapter_fault`. Any throw, abort, timeout, or invalid return from `start` is
ambiguous whatever the exception says; a throw from `recoverStart` is
`unknown`; a throw from `poll` is `retry`. Only a definitive mapped product
outcome may be a terminal failure. Core validates codes and hints, and no
exception message ever becomes public output.

`job` is a versioned reference such as `{v: 1, jobId, reportUrl}`: at most
16 KiB of canonical JSON, never the upstream response body or a credential
bundle. Core stores it encrypted and never interprets its URLs; the service
validates origin, path, and redirect policy before following one.

## The idempotency horizon

Core records the first start attempt and, when the adapter declares a
retention, `idempotencyValidBefore` = first attempt + retention, before the
first call. Retries never extend it.

- `recoverStart` first looks the job up authoritatively by the order key.
  Found: return it. A lookup that proves the job was never created and can no
  longer be created by the lost request may answer `authoritative-absence`.
- An empty eventually consistent search proves nothing: return `unknown`.
- Without proof of absence, `idempotent-replay` is allowed only inside the
  documented retention, with margin; core additionally requires the horizon
  to leave the call limit plus 120 seconds, and waits for an ambiguous start
  to settle before acting on absence.
- After the horizon, return `unknown` unless an authoritative lookup
  resolves the original operation. If the product's guarantee cannot be
  expressed this conservatively, require the lookup.
- A job URL returned only in the lost response is not a recovery method. If
  it carries bearer authority, keep it only in the encrypted job reference,
  out of logs, errors, and public diagnostics.

Only core schedules a start, always with the same key, never past the
fulfillment deadline, and never once the start is known to have executed.

## Pending, overdue, and polling

- `pending` reschedules the next poll after the configured interval, or
  after `pollAfterSeconds` when the product asks for longer (a hint never
  shortens it); pending polls never consume the failure budget.
- `retry` backs off from 15 seconds to 30 minutes; a product's
  `retryAfterSeconds` is always honored as a minimum.
- The fulfillment deadline (acceptance plus the listing's declared
  `fulfillmentSeconds`) is an overdue threshold, not proof of failure. A job
  that never recorded a start fails as `provider_job_not_started`; started,
  ambiguous, or invalid-result work stays `working`, starts nothing new, and
  keeps reading the original job no more often than the overdue interval
  (five minutes by default). A late valid report completes it once. The
  gateway may report its own deadline failure until it is explicitly
  revived; nothing refunds, renews payment, or reopens a terminal task.
- `requestReadiness` runs at quote time only. Mutable availability after
  payment delays the funded job; it is never a second purchase gate.

Declare `fulfillmentSeconds` to cover the maximum runtime, queueing,
retries, and report retrieval; the synthetic example declares 12 hours for an
eight-hour job.

## Result mapping

`resultSchema` describes the complete completed `ServiceResult` (`status`,
optional `message`, `artifacts`), which the artifact read returns exactly.
Failures carry only a code from the module's `failureCodes`; their messages
are dropped. That one list judges every installed adapter version, so keep a
code listed while a retained previous version can still return it. A terminal
report that fails the admitted schema or size bounds is an integration error,
not a product failure: the job stays `working`, nothing is signed `completed`,
no second job starts, and new quotes for that mapping stop until a repaired
mapper retrieves the same report. Keep the adapter `version` for a mapper fix
that changes neither the reference format nor the result contract. A report
too large for the schema needs a stable permitted location; never publish a
short-lived bearer URL as a permanent result.

## Synthetic walkthrough

The repository's example, `src/services/synthetic-audit`, wraps an in-memory
fake audit product with no real endpoint or secret
(`npm run try-skill -- synthetic-audit audit` tours it offline):

1. The buyer sends `{description}`. `requestReadiness` declines text the audit
   cannot take before any payment.
2. The funded dispatch is admitted as one queued job and answered
   `submitted`.
3. The worker records the start intent and calls `start`, which submits
   `{orderKey: idempotencyKey, description}` to the product's own creation
   operation and returns `accepted` with `{v: 1, jobId, reportUrl}` and a
   30-minute `pollAfterSeconds`.
4. If that answer is lost, the start is ambiguous; `recoverStart` finds the
   job by its order key, so no second audit exists. Finding nothing, it
   allows an `idempotent-replay` only inside the product's 24-hour
   guarantee, and answers `unknown` after it.
5. `poll` maps `running` to `pending`, `done` to the mapped report,
   `rejected` to the failure code `audit_rejected`, and a missing job to
   `retry`, since a job the product cannot find right now proves nothing.
6. After about eight hours the report is validated, frozen, and delivered
   through ordinary signed status and artifact reads.

Counter-example: the same audit documented only as a public x402 endpoint.
That documentation names no way to start work against an already-paid order,
no lookup after a lost response, and no report retention. Identify and report
those payment and recovery gaps; do not infer compatibility from the
walkthrough above, promise a direct listing, or spend a second payment to
probe it. A fake-backed adapter never establishes production readiness on its
own.

## Tests the implementation needs

- A lost start response (the product created the job, the answer was lost)
  recovers the original job; exact replays never create a second one.
- A key that expires during an outage yields `unknown`, never a resubmission.
- An invalid terminal report is never signed and never restarts the job; a
  repaired mapper recovers the same report.
- A completion after the deadline completes the task once.
- Every product state maps exactly. Timeouts, 429, and 5xx are `retry`
  from `poll`, `ambiguous` from `start`, and `unknown` from `recoverStart`.
- A restart in each phase, a deployment while a job is pending, and a
  compatible upgrade keep one job, run by the adapter version that sold the
  order (core records it with each quote, even when the order is first
  dispatched after the upgrade): retain the old adapter in
  `previousExternalJobAdapters` when the reference format or the result
  contract it maps to changes, while its jobs run or its quotes may still be
  dispatched, and keep every encryption key id stored jobs name. A quote
  without a recorded version (sold synchronously, or before migration 010)
  runs with the current adapter.

Core's PostgreSQL suites cover the scheduler; service tests use the fake.

## Enabling and operating

External-job admission needs `PROVIDER_DATA_ENCRYPTION_KEY` on every replica
and the operator's explicit `npm run daski:async-admission -- --activate`
after the cutover (never run it without that authority). `npm run doctor --
--database` and `/health/ready` report stalled workers, stale leases, overdue
work, start ambiguity, invalid results, and missing handlers or keys. Lite
answers `input`, `cancel`, and `support` with `409 unsupported_action` and no
effect; a payer-signed lifecycle retry needs a fresh authorization, while a
read capability is retried as is.
