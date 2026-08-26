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

It excludes dynamic quoting, background jobs, later input, cancellation,
durable assets, owner actions, email, admin UI/API, direct A2A, and multi-replica
execution recovery. Those belong in
[provider-full](https://github.com/daski-io/provider-full).

## Composition

`src/core` defines the service-neutral runtime and the `ServiceModule`
contract. `src/services/<slug>` implements a product. `src/providerServices.ts`
is the only installed-service list; `src/providerLaunchPolicy.ts` is the exact
reviewed outcome allowlist.

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

## Dispatch state machine

```text
new signed dispatch
       |
       v
verify all bindings and admitted chain evidence
       |
       v
PostgreSQL serializable claim ---- changed replay -> reject
       |                    \
       |                     same replay -> durable current/terminal response
       v
executing -- adapter result --> completed | failed
       |
       +-- process restart --> failed(provider_restarted_during_execution)
```

Core verifies before claim: envelope shape, duplicate keys, environment,
chain, audience, signer, lifetime, exact outcome, service/skill, quote,
request hashes/schema, payer, self-purchase policy, deposit/release ordering,
contract provenance, finality, source agreement, and sanctions state.

The verified payer is supplied to the adapter as context. It is not inferred
from input. The request body is not persisted. A terminal result is persisted
and signed so a legitimate same-dispatch replay is deterministic.

## Why one replica

The runtime performs the product operation inline and uses no job lease. On
startup it marks any `executing` rows failed because that process cannot know
whether an interrupted external call completed. That behavior is correct for
one active process and a strictly synchronous/reconcilable integration, but it
would interfere with another active replica. Use `provider-full` when execution
must survive restarts or scale across workers.

## Database boundary

The baseline creates only:

- `provider_transactions`;
- `standard_evidence_admissions`;
- `supplier_operations`; and
- `rate_limit_buckets`.

`_migrations` is created by the migration runner. Migrations are checksummed
and serialized with a PostgreSQL advisory lock. Production can use a privileged
migration principal and a separate restricted runtime principal.

## Network and process boundary

The server accepts JSON only on the paid POST routes, rejects compressed bodies
and duplicate JSON keys, applies header/body/time/concurrency limits, persists
shared rail rate limits, and emits generic public errors. Health is rate-limited
locally so it remains available when PostgreSQL is degraded.

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
- `/standard-rail/dispatch`
- `/standard-rail/dispatch/status`

There is no public product proxy. The adapter is reachable only after rail
admission.
