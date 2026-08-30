# Daski Provider — Minimal Starter

Expose one of your existing product operations as a paid service on
[Daski](https://daski.io). This repository supplies the smallest supported
provider-side boundary for discovery, standard Exact-EVM payment admission,
signed dispatch, replay protection, execution, and terminal evidence. You
supply the product integration and operate the deployed provider.

The normal first target is Daski Testnet on Base Sepolia. Mainnet is a separate
whitelisted release requested through the
[Daski Discord](https://discord.gg/uyeMp7Q2HW).

## Choose the right starter

| Use this repository (`provider`) when every operation is | Use [`provider-full`](https://github.com/daski-io/provider-full) when any operation needs |
| --- | --- |
| Fixed-price | Dynamic quoting |
| Fully automated | Human review or input |
| Synchronous and complete within 50 seconds | Long-running work, jobs, retries, or resumable lifecycle |
| One-shot, returning a terminal result | Durable customer assets or later owner actions |
| Safe to finish or fail during one dispatch | Ambiguous work that must reconcile after a restart |
| Operated as one active application replica | Multi-replica workers or richer operations |

Also choose `provider-full` for built-in admin, email, direct A2A, protected-data
workflows, background workers, cancellation, or asset management. Start there
when uncertain; removing unnecessary features is safer than rebuilding
durability after a product is admitted.

The two starters share the same Daski standard rail. They are alternatives,
not layers: do not install one inside the other. This repository is the
canonical home of the portable Daski provider agent skill.

## What is included

| Core owns | Your service owns |
| --- | --- |
| Discovery, AgentCards, and skill documents | Public service and skill descriptions |
| Gateway signature, audience, quote, request, payment, and evidence checks | Strict product input validation |
| Daski-issued runtime listing catalog and fixed payment bindings | One fixed API or MCP operation per skill |
| PostgreSQL replay/idempotency ledger and terminal results | Product credentials and response mapping |
| Provider terminal attestations and status lookup | Product-specific tests and safe error codes |
| HTTP limits, rate limits, outbound-network controls, health, and logging | Product dependency readiness and operations |

This is not a buyer SDK, generic API proxy, MCP gateway, payment simulator, or
hosting template. Paid calls arrive only through the Daski gateway. Your
adapter never decides whether payment is valid and must never accept a
buyer-selected URL, HTTP method, MCP server, tool name, or credential.

## Why the minimal provider still needs PostgreSQL

The offline example and unit tests do not need a database. A running paid
provider does. PostgreSQL is the small durable rail ledger that prevents a
signed dispatch or admitted chain event from being replayed after a process
restart. It stores:

- transaction identity, state, and terminal result;
- admitted public deposit and release evidence;
- shared rate-limit buckets; and
- optional external-mutation intent for operations that use the supplier
  journal.

It does not need to become your product database. Buyer request bodies are not
stored by this starter. Removing the ledger would make exactly-once dispatch
claims and restart-safe status impossible, so a database-free paid mode is not
supported.

## Five-minute offline tour

Install Node.js 24 and npm, then:

```bash
git clone https://github.com/daski-io/provider.git
cd provider
npm ci
npm run try-skill -- dummy echo "hello daski"
```

The command invokes only `src/services/dummy` in memory. It does not use a
wallet, database, RPC, gateway, payment, or external API. It is a code-path
tour, not a paid-order simulation.

Next read [Getting started](docs/getting-started.md), copy `.env.example`,
start the loopback-only PostgreSQL service, and run:

```bash
npm run dev:db:up
npm run doctor -- --stage=testnet
```

`doctor` is read-only, emits stable check codes, and never prints secret
values. A copied `.env.example` is intentionally not bootable: Daski supplies
a mutually consistent Testnet runtime bundle plus signer, contract, policy,
and evidence bindings during onboarding.

## How an order reaches your product

1. The provider publishes your service, skill, closed schemas, fixed
   atomic-USDC price, and legal/support metadata as a hashable contract.
2. Daski creates the fixed quote from the reviewed listing. This starter has
   no provider-side dynamic quote endpoint.
3. The gateway admits payment and sends a short-lived signed dispatch with the
   quote, exact request, payer, order, audience, and chain evidence.
4. Core verifies every binding and atomically claims the dispatch in
   PostgreSQL.
5. Your adapter maps the skill to one reviewed API endpoint or MCP tool and
   returns `completed` or `failed` within 50 seconds.
6. Core persists the terminal result and returns a provider-signed terminal
   attestation. Replays receive the same durable result.

If an external mutation can time out ambiguously and cannot be reconciled
within that same execution window, use `provider-full`. Never guess whether an
external purchase, provisioning call, or other non-convergent mutation
succeeded.

## Repository map

```text
src/core/                         service-neutral Daski and security boundary
src/services/dummy/               Testnet-only reference service, docs, tests
src/providerServices.ts           installed service composition
src/installRuntimeBundle.ts       verified Daski-assisted catalog importer
src/core/gatewayRegistration/     runtime commitment and catalog primitives
test/                              core and cross-service tests
docs/                              installation, integration, and onboarding
.agents/skills/daski-provider/    portable agent skill and routed references
scripts/                           local diagnostics and verification
compose.yaml                       loopback-only development PostgreSQL
Dockerfile                         hosting-neutral production image
```

Core must not import a service, and services must not import sibling services.
Service-specific tests stay under `src/services/<slug>/tests/`; `test/` is for
core and cross-service behavior.

## Integrate an API or MCP product

Start with [Integrating an existing product](docs/integrating-existing-product.md),
then follow [Adding a service](docs/adding-a-service.md). In short:

1. confirm the product fits the minimal starter;
2. copy `src/services/dummy` to `src/services/<your-slug>`;
3. replace its manifest, schema, validation, adapter, docs, and tests;
4. map each skill to a hard-coded, reviewed product operation;
5. install it in `src/providerServices.ts`;
6. coordinate the published contract and fixed price with Daski;
7. install the exact Daski-issued runtime bundle;
8. remove `dummy`; and
9. complete an end-to-end Testnet purchase before requesting Mainnet review.

## Build and verify

```bash
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
```

Unit gates need no live database, chain, gateway, or product. Database smoke
checks are intentionally separate and must target only a disposable database.
See [scripts/README.md](scripts/README.md).

## Deploy

The Dockerfile is the canonical production artifact; the upstream repository
does not prescribe a hosting vendor. A deployment needs a
stable public HTTPS `BASE_URL`, PostgreSQL 16+, runtime-injected secrets,
outbound Base RPC/product access, and one active application replica. Route
traffic only when `/health/ready` passes; `/health/live` proves only that the
process exists.

This minimal starter does not self-register or submit chain transactions.
Daski onboarding supplies a reviewed runtime bundle and matching global policy.
After configuring the supplied values, install the bundle once per service:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The importer verifies signatures, domains, provider intent, the exact local
skill-contract hashes and prices, runtime commitments, and splitter provenance
before an atomic append-only catalog promotion. Keep the file out of Git and
ordinary support messages.

Develop locally while pointing the provider and gateway at reviewed Base
Sepolia contracts. A fully private local payment topology also needs contracts,
a facilitator, signers, and newly issued artifacts and is protocol development,
not the provider quickstart.

## Documentation

- [Getting started](docs/getting-started.md)
- [Integrating an existing API or MCP product](docs/integrating-existing-product.md)
- [Adding a service](docs/adding-a-service.md)
- [Configuration](docs/configuration.md)
- [Testnet and Mainnet onboarding](docs/onboarding.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Protocol cheatsheet](docs/protocol-cheatsheet.md)
- [Agent skill](docs/agent-skill.md)
- [Security model](SECURITY.md)
- [Scripts](scripts/README.md)

Coding agents should read `AGENTS.md`, then the portable
`.agents/skills/daski-provider/SKILL.md`. Repository documentation is
authoritative after checkout. The separately packaged skill also includes
focused references for starter selection, product mapping, full-provider work,
and onboarding so it remains useful before a repository is cloned.

## Staying current

Fork this repository and retain it as an upstream remote:

```bash
git remote add upstream https://github.com/daski-io/provider.git
git fetch upstream
git merge upstream/develop
```

Keep product code inside its service folder and review protocol/migration
changes before merging. Never edit an applied migration. Replace the security
contact in `SECURITY.md` with a private channel operated by your organization.

## License

MIT. See [LICENSE](LICENSE).
