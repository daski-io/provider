# Architecture

## Scope

This repository is a deliberately narrow adapter between the Daski gateway and
one or more fixed-price synchronous product operations.

```text
buyer agent
    |
    v
Daski gateway -- signed fixed quote, dispatch, payment/evidence
    |
    v
provider core -- verify, atomically claim, attest, persist terminal result
    |
    v
ServiceModule -- validate and call one fixed API endpoint or MCP tool
    |
    v
existing product
```

Before payment the gateway asks for a signed fixed readiness quote: core
checks the exact request, listing version, capacity and an optional read-only
service readiness hook, persists the quote, and signs the listing's fixed
price for that request and payer. A later dispatch must bind to that
persisted quote. Intake discovery shares the quote URL and creates nothing.

It excludes dynamic quoting, background jobs, later input, cancellation,
durable assets, owner actions, email, admin UI/API, direct A2A, and multi-replica
execution recovery. Those belong in
[provider-full](https://github.com/daski-io/provider-full).

## Composition

`src/core` defines the service-neutral runtime and the `ServiceModule`
contract. `src/services/<slug>` implements a product. `src/providerServices.ts`
is the only installed-service list. Paid skills are derived from those
manifests; the append-only runtime catalog supplies the Daski-reviewed listing
commitments used at boot and dispatch.

Dependencies point inward:

```text
src/index.ts -> core + provider composition
provider composition -> service modules
service modules -> core contracts/security helpers
core -X-> services
service A -X-> service B
```

Static gates check that boundary, reject unreachable production modules, and
reject full-starter directories/routes/dependencies.

## Assisted registration boundary

The minimal starter intentionally does not create an ERC-8004 service, call a
gateway registration API, deploy a splitter, or send a chain transaction.
Daski onboarding supplies one `ProviderRuntimeBundleSetV1` per service plus a
matching signed global rail policy. `npm run daski:install-runtime -- --file`
verifies the provider and gateway signatures, exact local AgentCard contract,
fixed price, runtime commitment, chain/policy domains, and splitter provenance,
then promotes all skill versions atomically.

AgentCards publish a null service id before import and the catalog service id
after import. A new contract, price, service id, or runtime commitment requires
a newly reviewed bundle; catalog history is never rewritten.

Promotion only supersedes a head. New sales (quotes, intake, the outcome list)
use heads; servicing uses every installed version, looked up by its runtime
commitment hash (re-verified against its content) with the definition it was
admitted with: schemas, price, deadlines, the fulfillment window (the
gateway's 30-day default when a contract declares none) and the handler. A
funded order paid against a superseded version is served exactly as it was
sold. Answers about an order are signed with the provider wallet its version
recorded, from a retained previous key after a rotation, and servicing calls
may name a retained previous provider audience (`docs/configuration.md`).
Boot and the importer refuse a build that cannot service every obligation:
claims need their version's signing key, and versions whose quotes may still
be dispatched also need their definition and handler.

## Dispatch state machine

```text
signed dispatch (always a fresh envelope)
       |
       v
authenticate envelope ---- fails -> definite refusal (JSON error)
       |
       v
claim for (gateway audience, order)?
       |-- same dispatch hash ----> current signed snapshot (even after expiry)
       |-- different hash --------> ambiguous empty 503 (never replaced)
       |-- unreadable ------------> ambiguous empty 503
       v none
verify current envelope, outcome, QuoteV1, persisted provider quote,
request, readiness, chain evidence, sanctions ---- fails -> definite refusal
       |
       v
claim commit (fenced at envelope validBefore) -- expired -> definite refusal
       |                                     \-- outcome unknown -> re-read or 503
       v
executing (public "working") -- adapter result --> completed | failed
       |   owner + lease token,    (validated against the admitted result
       |   lease renewed while     contract; state, result, result hash and
       |   the call runs           completion time frozen in one write, only
       |                           by the unexpired lease holder)
       +-- lease expired (owner crashed or stalled) -->
             failed(provider_execution_abandoned), by any process
```

A JSON `error` from dispatch therefore always means "definitely not
admitted"; once a claim exists or its commit is uncertain, the gateway gets the
signed snapshot or an empty 503 and reconciles through status. Every snapshot
is re-read and re-signed with a fresh database-clock `observedAt`; the
operations revision is persisted per task and a revision can only change with
its projection (database-enforced).

Core verifies before claim: envelope shape, duplicate keys, environment,
chain, audience, signer, lifetime, exact outcome, service/skill, quote,
request hashes/schema, payer, self-purchase policy, deposit/release ordering,
contract provenance, finality, source agreement, and sanctions state. Listing
capacity, paused sales and quote age never refuse a funded dispatch.

The verified payer is supplied to the adapter as context. It is not inferred
from input. The request body is not persisted. A terminal result is persisted
and attested so a legitimate same-dispatch replay or status read is
deterministic: the terminal transition writes the state, the result, its
canonical hash and the completion time together, and a database trigger
refuses any later change to them or to the claim's admitted bindings. Every
attestation signs the frozen hash; rows from before the hash existed are
attested from their stored result unchanged.

## Execution ownership and why one replica

The runtime performs the product operation inline. Each claim records the
process instance executing it, a fencing token and an expiring lease
(migration 006): 30 seconds, renewed every 10 seconds while the at most
50-second call runs and its result is persisted. Only the token holder can
renew or finalize, and only before expiry. A holder whose renewal finds the
lease lost aborts the call's signal and answers ambiguously; a holder that
finishes late writes nothing.

Every process sweeps expired leases at startup and every 15 seconds, failing
those executions with `provider_execution_abandoned`: their owner can no
longer finalize, and the runtime cannot know whether an interrupted product
call completed. The sweep never touches another process's live call, so a
restart or an overlapping compatible process (during an R1-to-R1 upgrade) is
safe, and it never touches the supplier journal, so a possible mutation stays
exactly as ambiguous as it was. An abandoned synchronous execution is never
resumed or taken over.

This makes restarts and short overlaps safe; it is not a horizontally scaled
worker platform. Operate one active replica. Use `provider-full` when
execution must resume after restarts or scale across workers.

Rows a pre-R1 process left `executing` have no lease. Nothing resolves them
automatically: the operator's stop-and-drain cutover
(`docs/onboarding.md`) inventories them and, once every old process is
stopped, fails them as the old image would have at its next boot
(`provider_restarted_during_execution`). No input, lease or job handle is
invented for them.

## Database boundary

The migrations create only:

- `provider_transactions`;
- `standard_evidence_admissions`;
- `supplier_operations`;
- `rate_limit_buckets`;
- `provider_runtime_listing_versions`;
- `provider_quotes` (signed readiness quotes, retained for dispatch binding);
  and
- `provider_schema_epoch` (the compatibility epoch the schema requires).

`_migrations` is created by the migration runner. Migrations are append-only,
checksummed, serialized with a PostgreSQL advisory lock, and pinned by the
static-gate allowlist together with the tables each one creates. Production
uses a schema-owning migration principal and a separate runtime principal that
receives only the reviewed per-table grants in `src/core/db/runtimePrivileges.ts`.

A provider quote can back a dispatch long after it expires, because the
gateway re-dispatches a timely-paid order until its first release observation
plus the snapshot's fulfillment window. Each quote therefore records
`retain_until` (its `validBefore` plus its listing version's fulfillment
window plus 30 days), and every claim records the provider quote it was
admitted against. Boot prunes, as the schema owner and in bounded batches,
only quotes past that retention, older than every installed version's window
plus the margin, and named by no claim; a trigger refuses any other quote
deletion, whoever attempts it. Claims, terminal results and their reads are
never pruned.

## Upgrade compatibility barrier

The pre-R1 image ignores migration files it does not know and, at every boot,
fails every `executing` row with one unconditional UPDATE. An executable cannot
be taught a check it does not contain, so the database excludes it instead
(migration 005):

- Every connection this build opens carries the session setting
  `daski.runtime_epoch` (its supported schema epoch) in its startup options.
- A statement-level trigger on every provider table, the migration ledger
  included, refuses any INSERT, UPDATE, DELETE or TRUNCATE from a session
  whose marker is missing or older than `provider_schema_epoch.epoch`. It
  fires once per statement, so the old sweep fails even when it matches no
  rows.
- Forced row security on `_migrations` refuses an unmarked read. The old
  runner reads its ledger first, as the schema owner, so the old image stops
  there: before its privilege reset, before its sweep, before it listens.
  A superuser bypasses row security but still meets the triggers.

Before its first mutation each executable (server, importer) refuses a schema
epoch newer than its own; after migrating it verifies that the epoch is
exactly its own, that every table it owns carries the enabled barrier
trigger, that the ledger forces its policy, and that runtime sessions carry
an admitted marker. A compatible additive migration keeps the epoch, so
compatible builds may overlap; an incompatible schema raises it, which the
database then enforces against every older process at once.

Async admission is a separate database switch (migration 008), off through
migrations, the importer and boot; only `npm run daski:async-admission --
--activate` turns it on, after verifying the barrier, the absence of pre-R1
executions, retained obligations and that every running instance (a
heartbeat registry in `provider_runtime_instances`) is a compatible worker.

This is a compatibility control against stale code, not protection from a
database credential holder: any session may declare the marker. The actual
pre-R1 compiled image is qualified against it in
`test/legacyImageBarrierPostgres.test.ts` (see `docs/releasing.md`): it cannot
boot under a single owner, separate principals or a superuser, and cannot
change a row from code that was already running. No in-database control can
stop a schema owner's GRANT/REVOKE, so the old privilege-reset routine can
still rewrite grants when run outside its boot path, or by an old boot under
a layout both images refuse (a superuser or BYPASSRLS migration principal,
which bypasses the ledger's row security; that old boot refuses the layout
only after resetting). Neither changes a row, and this build fails closed
meanwhile. Its next boot restores the reviewed grants, except that a reset
run by a superuser also takes over the schema, which the operator must hand
back first (`docs/troubleshooting.md`).

## Network and process boundary

The server accepts JSON only on the paid POST routes, rejects compressed bodies,
duplicate JSON keys and pathologically deep or large documents, applies
header/body/time/concurrency limits, persists
shared rail rate limits, and emits generic public errors. Health is rate-limited
locally so it remains available when PostgreSQL is degraded.

Dispatch, its status and buyer lifecycle reads are servicing calls for
already-funded orders, classified by Express's own route matching. They keep
bounded ingress, authentication, and a per-source PostgreSQL limit charged
only by unauthenticated failures, but skip the product-readiness gate and the
request-charged purchase/global limits. A middleware refusal is a definite
JSON refusal (no handler ran); only dispatch and status handlers answer
ambiguously, and new synchronous dispatches still refuse before admission
while readiness is down. Lifecycle has no admission to be ambiguous about:
anything it cannot serve right now, including a busy or rate-limited call and
an escaped error, is the named `503 lifecycle_unavailable`. Lifecycle calls
carry the buyer's own request object, so they use a separate failure bucket
charged only by unauthenticated grants; nothing a buyer sends through the
gateway can exhaust the budget that paid dispatches depend on. New quotes
require complete provider readiness and pass the purchase limit.

The lifecycle route verifies the gateway's `ProviderLifecycleGrantV1` before
it interprets the authorization, then serves `status` and `artifact` only:
one indexed claim read, a fresh observation and fresh signatures, with the
artifact taken from the frozen result after its hash is re-verified.
`input`, `cancel` and `support` get the named `unsupported_action` refusal
without a lookup. It never reaches the adapter (static gate).

Product HTTP must use the bounded outbound helpers, which enforce reviewed
HTTPS destinations, DNS/IP safety, redirect policy, timeouts, response-size
limits, and per-origin control. Service code cannot call raw `fetch`.

The Docker image is digest-pinned, contains only compiled runtime files and
production dependencies, removes npm/npx, and runs as the unprivileged `node`
user. Hosting configuration is intentionally left to the provider fork.

## Public surfaces

- `/health`, `/health/live`, `/health/ready`
- `/.well-known/agent.json`
- `/.well-known/agent-registration.json`
- `/agent-cards/<slug>.json`
- `/skills/<slug>.md` and `/skills/<slug>/<skill>.md`
- `/llms.txt`
- `/standard-rail/outcomes`
- `/standard-rail/quote` (readiness quote and intake)
- `/standard-rail/dispatch`
- `/standard-rail/dispatch/status`
- `/standard-rail/lifecycle` (authenticated status and artifact reads)

There is no public product proxy. The adapter is reachable only after rail
admission.
