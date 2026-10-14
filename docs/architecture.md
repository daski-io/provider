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
       |
       +-- process restart --> failed(provider_restarted_during_execution)
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
deterministic.

## Why one replica

The runtime performs the product operation inline and uses no job lease. On
startup it marks any `executing` rows failed because that process cannot know
whether an interrupted external call completed. That behavior is correct for
one active process and a strictly synchronous/reconcilable integration, but it
would interfere with another active replica. Use `provider-full` when execution
must survive restarts or scale across workers.

## Database boundary

The migrations create only:

- `provider_transactions`;
- `standard_evidence_admissions`;
- `supplier_operations`;
- `rate_limit_buckets`;
- `provider_runtime_listing_versions`; and
- `provider_quotes` (signed readiness quotes, retained for dispatch binding).

`_migrations` is created by the migration runner. Migrations are append-only,
checksummed, serialized with a PostgreSQL advisory lock, and pinned by the
static-gate allowlist together with the tables each one creates. Production
uses a schema-owning migration principal and a separate runtime principal that
receives only the reviewed per-table grants in `src/core/db/runtimePrivileges.ts`.

## Network and process boundary

The server accepts JSON only on the paid POST routes, rejects compressed bodies,
duplicate JSON keys and pathologically deep or large documents, applies
header/body/time/concurrency limits, persists
shared rail rate limits, and emits generic public errors. Health is rate-limited
locally so it remains available when PostgreSQL is degraded.

Dispatch and its status are servicing calls for already-funded orders. They
keep bounded ingress, authentication, and a per-source limit on
unauthenticated failures, but skip product readiness and the purchase/global
rate limits, and no middleware answers them with a JSON refusal. New quotes,
by contrast, require complete provider readiness and pass the purchase limit.

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

There is no public product proxy. The adapter is reachable only after rail
admission.
