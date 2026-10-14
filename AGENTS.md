# AGENTS.md — Daski minimal provider guide

This is the canonical repository guide for coding agents and contributors.
Read it before changing code. Keep durable decisions in tracked documentation,
not chat history or a harness-specific file.

## Repository purpose

This is the minimal Express + TypeScript starter for offering fixed-price,
fully automated services through Daski. It receives discovery, signed
dispatch, payment evidence, status, terminal-outcome and authenticated buyer
status/artifact lifecycle calls over the standard Exact-EVM rail.

Use this repository only when every paid operation is fixed-price and
automated, needs no later buyer input, cancellation, asset or operator
workflow, and either returns a terminal result within the 50-second
synchronous budget or is a product-owned asynchronous job that core can
start, recover by its stable key and poll (external-job mode). For dynamic
quotes, provider-owned multi-step workflows, human input, assets/actions,
admin, email, direct A2A, or intentional multi-replica workers, use
`https://github.com/daski-io/provider-full`.

The only installed service is `src/services/dummy`, a Testnet-only paid echo
reference. A provider fork replaces it with its product service. Do not copy
provider-specific services or retired payment rails into this repository.

## Architecture boundary

- `src/core/` owns Daski protocol, identity, payment/evidence verification,
  the minimal PostgreSQL rail ledger, security, discovery, and HTTP runtime.
- `src/core/externalJobs/` owns external-job admission, the durable worker
  (leases, phases, scheduling, recovery) and encrypted job state; it is the
  only code that calls an external-job adapter (`calls.ts`).
- `src/services/<slug>/` owns one service's manifest, validation, adapter,
  product configuration/client, docs, and co-located tests.
- `src/providerServices.ts` is the single installed-service composition.
- Paid-skill launch policy is derived from the installed manifests.
- `src/installRuntimeBundle.ts` verifies and atomically promotes the
  Daski-issued runtime catalog; this starter does not self-register.

Core must never import from services. Services must never import sibling
services. Product behavior must remain behind a typed service adapter. The
architecture gate enforces these directions and rejects full-starter surfaces.

Service-specific tests belong in `src/services/<slug>/tests/`. `test/`
contains only core and cross-service tests.

## Commands

```bash
npm run try-skill -- dummy echo "hello"
npm run dev:db:up
npm run doctor -- --stage=testnet
npm run dev
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run skill:validate
npm run test:run
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run security:audit
npm run build
npm start
```

Node 24 and PostgreSQL 16+ are required for a running paid provider. The
offline dummy and unit suite need no database, wallet, RPC, gateway, or product.
`doctor` is read-only and redacted. A copied `.env.example` cannot boot until
Daski supplies the reviewed Testnet artifacts.

## Change workflow

1. Decide whether the operation still fits this minimal starter. Stop and
   recommend `provider-full` if it does not.
2. Inspect the closest types, implementation, docs, and tests.
3. Make the smallest cohesive change; update contract, validation, adapter,
   docs, composition, catalog expectations, and tests together.
4. Keep API/MCP targets in a fixed allowlist. Never pass through a buyer URL,
   HTTP method, MCP server, tool name, credential, or arbitrary headers.
5. Run targeted tests, then all relevant repository gates.
6. Scan the diff for secrets, personal data, product account details, raw
   product output, and organization-specific leakage.
7. Never weaken a fail-closed check to make a fixture or deployment pass.

Keep files near 250 lines where practical and split by cohesive responsibility.

## Implementation invariants

- Every skill has a reviewed fixed atomic-USDC price. Core answers the
  gateway's signed readiness quote with that fixed amount; there is no
  dynamic pricing. An optional read-only `requestReadiness` hook may decline
  a request before payment but cannot change the price or start work.
- Validate input both at the rail schema and in the adapter. Reject unknown
  fields and apply explicit size/range limits.
- A synchronous adapter returns only `completed` or `failed`, honors its
  `AbortSignal` and finishes within the 50-second synchronous budget. An
  external-job adapter (`mode: "external-job"`) returns only the typed
  outcome unions; any throw, abort, timeout or invalid return from `start`
  is ambiguous and reconciled with `recoverStart` (read-only) under the
  original key, never retried blindly. Only core schedules a start.
- `resultSchema` describes the complete completed `ServiceResult`; core
  validates results against the admitted schema before freezing them. Failure
  evidence is only a code listed in the module's `failureCodes`.
- A terminal task's state, result, result hash and completion time are frozen
  in one write and never change; legacy rows are never reshaped.
- Lifecycle calls verify the gateway's `ProviderLifecycleGrantV1` before
  interpreting the authorization. A read capability authorizes only `status`
  and `artifact`; `input`, `cancel` and `support` answer exactly
  `409 unsupported_action` with no effect. Lifecycle reads never call the
  adapter, write, or answer 500.
- PostgreSQL is mandatory for paid runtime replay/idempotency, evidence,
  rate-limit, and terminal-result state. Do not replace it with memory state.
- Dispatch claims, financial/evidence state, and external mutation intent use
  conditional writes, transactions, locks, and stable idempotency keys.
- A dispatch JSON `error` means "definitely not admitted". Once a claim exists
  or its commit is uncertain, answer the signed snapshot or the empty-body
  503; only a verified status query with no claim gets the `outcome_policy`
  404. Never refuse a funded dispatch for capacity, paused sales, or quote
  age, and never cache a signed response.
- For a non-convergent product mutation, journal intent before the call and
  reconcile authoritative product state after ambiguity. If reconciliation
  cannot complete synchronously, use `provider-full`; never guess or blindly
  retry.
- A buyer-authorized payer comes only from the verified dispatch. Request
  fields, order ids, artifact ids, and caller metadata are not credentials.
- Use `boundedFetch`, `PinnedHttpClient`, or `reviewedEndpoint` for product
  HTTP. Do not call `fetch` directly from a service.
- Never log request/product payloads, credentials, private keys, or signed
  authorization material. Public errors are stable and generic.
- Applied migrations are immutable and checksummed. New migrations are
  append-only, listed in the static-gate allowlist with the tables they
  create, and every new table needs a reviewed runtime-role grant and the
  statement-level `provider_runtime_epoch_barrier()` trigger. Raise
  `RUNTIME_SCHEMA_EPOCH` and the `provider_schema_epoch` row only for a schema
  change older runtimes cannot use safely.
- The async-admission switch changes only through `npm run
  daski:async-admission`; migrations, the importer and boot never enable it.
- Treat published contract hashes and fixed-price changes as coordinated Daski
  onboarding changes. Request and install a new signed runtime bundle; never
  edit catalog rows or issued artifacts.
- The dummy service is forbidden on Base Mainnet and must be removed before
  Mainnet review.

## Deployment assumptions

The upstream starter is hosting-neutral. Use its Dockerfile, stable HTTPS,
durable PostgreSQL, runtime-injected secrets, and `/health/ready` for traffic.
Operate one active application replica. Synchronous executions carry a
persisted owner and an expiring lease: a restart or an overlapping compatible
process never fails a live call, and only an expired lease is failed
(`provider_execution_abandoned`); a synchronous call is never resumed.
External jobs are durable: their worker finds due and abandoned work in
PostgreSQL after a restart and resumes it in its persisted phase without
resubmitting. The first upgrade from a pre-R1 image is the stop-and-drain
cutover in `docs/onboarding.md` (`npm run daski:cutover`).

Testnet is the normal first target. Mainnet requires production configuration,
canonical reviewed contracts, separate runtime/migration database roles,
verified TLS and proxy posture, removal of dummy, a successful Testnet review,
and explicit Daski whitelisting through Discord.

## Documentation

Start at `README.md`, then use:

- `docs/getting-started.md`
- `docs/integrating-existing-product.md`
- `docs/adding-a-service.md`
- `docs/configuration.md`
- `docs/onboarding.md`
- `docs/troubleshooting.md`
- `docs/architecture.md`
- `docs/protocol-cheatsheet.md`
- `docs/agent-skill.md`
- `SECURITY.md`
- `scripts/README.md`

The portable agent entrypoint is `.agents/skills/daski-provider/SKILL.md`.
It routes work to these authoritative files and must remain harness-agnostic.

## Git policy

Work lands on `develop` or a branch merged into `develop`. Do not push `main`
or create a release/tag without explicit authorization in the current session.
Do not add AI-tool attribution or co-author trailers to commits, pull requests,
tags, or release notes.
