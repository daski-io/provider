# AGENTS.md — Daski minimal provider guide

This is the canonical repository guide for coding agents and contributors.
Read it before changing code. Keep durable decisions in tracked documentation,
not chat history or a harness-specific file.

## Repository purpose

This is the minimal Express + TypeScript starter for offering fixed-price,
fully automated, synchronous services through Daski. It receives discovery,
signed dispatch, payment evidence, status, and terminal-outcome calls over the
standard Exact-EVM rail.

Use this repository only when every paid operation returns a terminal result
within 50 seconds and does not create a durable customer asset or later
lifecycle. For dynamic quotes, jobs, human input, retries across restarts,
assets/actions, admin, email, direct A2A, or multi-replica workers, use
`https://github.com/daski-io/provider-full`.

The only installed service is `src/services/dummy`, a Testnet-only paid echo
reference. A provider fork replaces it with its product service. Do not copy
provider-specific services or retired payment rails into this repository.

## Architecture boundary

- `src/core/` owns Daski protocol, identity, payment/evidence verification,
  the minimal PostgreSQL rail ledger, security, discovery, and HTTP runtime.
- `src/services/<slug>/` owns one service's manifest, validation, adapter,
  product configuration/client, docs, and co-located tests.
- `src/providerServices.ts` is the single installed-service composition.
- `src/providerLaunchPolicy.ts` is the exact reviewed paid-outcome allowlist.

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
   docs, composition, launch policy, and tests together.
4. Keep API/MCP targets in a fixed allowlist. Never pass through a buyer URL,
   HTTP method, MCP server, tool name, credential, or arbitrary headers.
5. Run targeted tests, then all relevant repository gates.
6. Scan the diff for secrets, personal data, product account details, raw
   product output, and organization-specific leakage.
7. Never weaken a fail-closed check to make a fixture or deployment pass.

Keep files near 250 lines where practical and split by cohesive responsibility.

## Implementation invariants

- Every skill has a reviewed fixed atomic-USDC price. There is no dynamic
  provider quote callback.
- Validate input both at the rail schema and in the adapter. Reject unknown
  fields and apply explicit size/range limits.
- An adapter returns only `completed` or `failed` and honors its `AbortSignal`.
  It must finish within the 50-second core budget.
- PostgreSQL is mandatory for paid runtime replay/idempotency, evidence,
  rate-limit, and terminal-result state. Do not replace it with memory state.
- Dispatch claims, financial/evidence state, and external mutation intent use
  conditional writes, transactions, locks, and stable idempotency keys.
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
- Applied migrations are immutable and checksummed. This starter intentionally
  begins with one baseline migration; future changes are append-only.
- Treat `providerLaunchPolicy` and fixed-price changes as coordinated Daski
  onboarding changes. The signed outcome artifact must match exactly.
- The dummy service is forbidden on Base Mainnet and must be removed before
  Mainnet review.

## Deployment assumptions

The upstream starter is hosting-neutral. Use its Dockerfile, stable HTTPS,
durable PostgreSQL, runtime-injected secrets, and `/health/ready` for traffic.
Operate one active application replica. This minimal runtime marks incomplete
synchronous executions failed after restart; it does not implement distributed
execution leases or job recovery.

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
