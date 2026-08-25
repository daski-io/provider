# AGENTS.md — Daski provider starter guide

This file is the canonical repository guide for coding agents and contributors.
Read it before changing code. Keep durable project knowledge in tracked
documentation, not in chat history or harness-specific files.

## Repository purpose

This is the generic Express + TypeScript starter for organizations offering
services through Daski. It receives discovery, quote, signed dispatch,
lifecycle, wallet-action, and evidence calls over the standard Exact-EVM rail.

The repository intentionally includes only one marketplace service:

| Slug | Folder | Purpose |
| --- | --- | --- |
| `dummy` | `src/services/dummy` | Reference implementation with free `echo` and paid `create-note` skills |

The dummy has no supplier or private policy and is forbidden on Base mainnet.
A provider fork should replace it with its own service.

Do not reintroduce retired payment routers, alternate native payment paths, or
provider-specific code from another repository.

## Architecture boundary

- `src/core/` owns protocol, identity, payment/evidence verification,
  persistence, jobs, security, admin, email, and service-neutral contracts.
- `src/services/<slug>/` owns one service's manifest, skills, adapter,
  validation, configuration, migrations, docs, workers, supplier integration,
  protected-data declarations, admin extensions, and tests.
- `src/providerServices.ts` is the single installed-service composition.
- `src/providerLaunchPolicy.ts` is the exact reviewed outcome/action allowlist.
- `src/providerScreening.ts` is the optional provider-policy composition.

Core must never import from services. Services must never import sibling
services or provider-specific extensions. Keep provider-policy implementations
independent of individual services. ESLint and the architecture gate enforce
these directions.

Service-owned tests belong in `src/services/<slug>/tests/`. `test/` contains
only core and cross-service tests.

## Commands

```bash
npm run dev
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run test:run
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run build
npm start
```

Node 24 and PostgreSQL are required. Unit tests need no live database, RPC, or
supplier. PostgreSQL security/migration scripts require an explicitly selected
disposable database.

## Change workflow

1. Inspect the closest types, implementation, docs, and tests before editing.
2. Make the smallest cohesive change.
3. Update public manifest/docs, runtime code, validation, migrations, and tests
   together when a contract changes.
4. Keep service behavior within the service folder.
5. Run targeted tests, then the full quality gates appropriate to the change.
6. Scan the diff for credentials, customer data, supplier account data,
   private policy, raw runtime output, and provider-specific leakage.
7. Never weaken a fail-closed check merely to make a fixture or deployment
   pass.

Keep files near 250 lines when practical. Split by responsibility before
adding another large branch to an already-large module.

## Implementation invariants

- Quote validates buyer data before payment; execute revalidates it.
- Financial and lifecycle state changes use conditional writes, locks, leases,
  idempotency keys, and fencing. Never use process-local money/task guards.
- Journal intent before a non-convergent external mutation. Reconcile
  authoritative supplier state after ambiguity; never guess or blindly retry.
- Persist signed chain writes before broadcast and reconcile them after restart.
- Ownership comes from the wallet-authorized payer. Order ids, asset ids, and
  caller metadata are not credentials.
- Consequential asset mutations require an admitted standard action. Destructive
  actions also require the delayed second-authorization flow and adversarial
  mismatch/replay tests. Do not invent a service-local signature scheme.
- Migrations are append-only once published and are checksummed. Core
  migrations live under `src/core/db/migrations/`; service migrations stay
  with their service.
- Use the centralized logger. Never log protected payloads or include
  supplier-controlled details in public errors.
- Direct supplier HTTP must use the reviewed outbound network boundary, with
  pinned endpoints, bounded responses/timeouts, and SSRF protection.
- Declare workers and live invariants through service readiness so
  `/health/ready` fails closed.
- Treat `providerLaunchPolicy` changes as coordinated Daski onboarding/release
  changes. Signed artifacts must contain the exact same set.

## Configuration and environments

`.env.example` is Testnet-first. A full boot needs Daski-issued signed
standard-rail artifacts and valid contract/signer bindings; placeholders are
expected to fail.

The upstream starter is hosting-neutral. The Dockerfile is the canonical
production artifact; provider forks may add their own deployment descriptors.
Every hosting platform must use `/health/ready` for traffic activation and
keep at least one provider process running while services are active.

Service-specific environment variables belong in
`src/services/<slug>/config.ts` and must be parsed strictly. Keep credentials
out of manifests, documentation, errors, and tests. Testnet services should use
supplier sandboxes or explicit fakes. Mainnet service modules must refuse mock
suppliers and enforce their own live readiness evidence.

The dummy service must remain incapable of booting on Base mainnet.

## Public surfaces

- `/health/live`, `/health/ready`
- `/.well-known/agent.json`,
  `/.well-known/agent-registration.json`
- `/agent-cards/<slug>.json`, `/skills/*`, `/llms.txt`
- `/standard-rail/*`
- `/a2a/:serviceSlug`
- `/admin/ui/*`, `/admin/*`
- `/webhooks/postmark/*`

## Documentation

Start at `README.md`, then use:

- `docs/adding-a-service.md`
- `docs/architecture.md`
- `docs/daski-skill-creation-best-practices.md`
- `docs/protocol-cheatsheet.md`
- `docs/service-taxonomy.md`
- `docs/standard-rail-evidence-v2.md`
- `SECURITY.md`

Do not leave the only copy of a durable decision in `.claude/`, `.codex/`,
another harness directory, or assistant memory.

## Git policy

Work lands on `develop` or a branch merged into `develop`. Do not push
`main` without explicit authorization in the current session. Never add AI
tool attribution or co-author trailers to commits, pull requests, tags, or
release notes.
