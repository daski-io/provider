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

Pick one of three paths from the product's facts, not from how long a call
takes:

| Path | Use it when every paid operation |
| --- | --- |
| This repository, synchronous mode | Is fixed-price and automated, returns its terminal result within the 50-second synchronous budget, needs no later buyer, asset or operator step, and leaves no mutation ambiguity unresolved when the call ends. |
| This repository, external-job mode | Is fixed-price and automated, and the product already runs the paid work as its own job: it starts promptly, returns or can look up a durable job reference by the order key, is polled until a report that fits the declared result schema, and can prove whether a lost start happened. No later buyer input, cancellation, asset or operator workflow. |
| [`provider-full`](https://github.com/daski-io/provider-full) | Needs dynamic pricing, provider-owned multi-step workflows, later input or cancellation, assets and owner actions, human or operator review, richer protected data, email, admin, direct A2A, or intentional multi-replica operation. |

Duration alone never selects `provider-full`: an eight-hour product job that
can be started safely and found again is an external job here. Choosing
`provider-full` does not supply a missing product guarantee either: if a
lost start cannot be reconciled, that is an upstream integration gap to
close before onboarding in either repository. An existing x402 endpoint does
not make a product compatible by itself; Daski's managed payment is the
purchase (see "How an order reaches your product").

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
| External-job worker: persistence, stable operation keys, leases, polling, restart recovery, retained adapter versions, encrypted job state | For a product job: start, read-only recovery lookup, poll and report mapping |
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

- transaction identity, state, execution lease, terminal result, and
  operations revision;
- signed readiness quotes that later dispatches bind to;
- admitted public deposit and release evidence;
- shared rate-limit buckets;
- optional external-mutation intent for operations that use the supplier
  journal; and
- for external jobs, one row per job with its phase, schedule, lease and
  encrypted input and job reference.

It does not need to become your product database. A synchronous call's
request body is not stored; an external job's input is kept, encrypted, only
until the job finishes. Removing the ledger would make exactly-once dispatch
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
tour, not a paid-order simulation. `npm run try-skill -- synthetic-audit
audit` tours the external-job example the same way, with a fake clock.

Next read [Getting started](docs/getting-started.md), copy `.env.example`,
start the loopback-only PostgreSQL service, and run:

```bash
npm run dev:db:up
npm run doctor -- --stage=testnet
```

`doctor` is read-only, emits stable check codes, and never prints secret
values; `--database` adds read-only database diagnostics. A copied
`.env.example` is intentionally not bootable: Daski supplies a mutually
consistent Testnet runtime bundle plus signer, contract, policy, and evidence
bindings during onboarding.

## How an order reaches your product

1. The provider publishes your service, skill, closed schemas, fixed
   atomic-USDC price, and legal/support metadata as a hashable contract.
2. Before issuing a payment challenge, the gateway asks the provider for a
   signed readiness quote. Core validates the request, checks capacity and
   optional service readiness, and signs the listing's fixed price for that
   exact request and payer. There is no dynamic pricing.
3. The gateway admits payment and sends a short-lived signed dispatch with the
   quote, exact request, payer, order, audience, and chain evidence.
4. Core verifies every binding, including the persisted provider quote, and
   atomically claims the order in PostgreSQL before the envelope expires.
5. Synchronous mode: your adapter maps the skill to one reviewed API
   endpoint or MCP tool and returns `completed` or `failed` within the
   50-second synchronous budget. External-job mode: core commits the funded
   order as one queued job and answers `submitted` at once; its worker then
   calls your adapter's `start`, `recoverStart` and `poll` hooks in short,
   bounded calls until the product reports, for hours if the declared
   fulfillment window allows.
6. Core validates the result against the listing's admitted result schema,
   freezes it with its hash, and returns a provider-signed snapshot with a
   terminal attestation. Exact replays and status reads receive the same
   durable result, freshly observed and re-signed.
7. The buyer reads status and the artifact through the gateway's signed
   lifecycle call; the artifact is the frozen result itself. Follow-up input,
   cancellation and support are answered as unsupported.

HTTP call time and fulfillment time are different clocks: every call into
this provider is short, while an external job's fulfillment may take hours
and is tracked through status reads, never through a request held open. The
adapter receives work only after core verified Daski's managed payment and
dispatch; Daski does not list arbitrary x402 endpoints, and an adapter never
pays an upstream endpoint again for an order Daski already admitted.

Never guess whether an external purchase, provisioning call, or other
non-convergent mutation succeeded. In synchronous mode an ambiguity must be
resolved within the call; a product job that can be found again by its order
key belongs in external-job mode, where core journals the start and
reconciles it after any restart.

## Repository map

```text
src/core/                         service-neutral Daski and security boundary
src/core/externalJobs/            external-job admission, worker and job state
src/core/diagnostics/             read-only database checks for the doctor
src/services/dummy/               Testnet-only synchronous reference service
src/services/synthetic-audit/     Testnet-only external-job example (not composed)
src/providerServices.ts           installed service composition
src/installRuntimeBundle.ts       verified Daski-assisted catalog importer
src/upgradeCutover.ts             pre-R1 stop-and-drain cutover inventory
src/activateAsyncAdmission.ts     async-admission switch (operator command)
src/doctorDatabase.ts             doctor's read-only database mode
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

1. choose the path: synchronous, external job, or `provider-full`;
2. copy `src/services/dummy` (synchronous) or `src/services/synthetic-audit`
   (external job) to `src/services/<your-slug>`;
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
process exists. `/health/ready` passes while funded orders' status and
artifact reads can be served; its `admission` part says whether new sales are
taken and its `servicing` part reports owed work
([Troubleshooting](docs/troubleshooting.md#reading-healthready)).

This minimal starter does not self-register or submit chain transactions.
Daski onboarding supplies a reviewed runtime bundle and matching global policy.
After configuring the supplied values, install the bundle once per service:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

Upgrading a deployment that ran a pre-R1 image is a stop-and-drain cutover
(`npm run daski:cutover`), described in
[docs/onboarding.md](docs/onboarding.md#upgrading-a-pre-r1-deployment-stop-and-drain-cutover).
External jobs additionally need `PROVIDER_DATA_ENCRYPTION_KEY` and the
operator's explicit `npm run daski:async-admission -- --activate`; no
migration, import or boot turns that switch on. Later compatible upgrades
keep the old listing versions, URLs, signing and encryption keys and adapter
versions that unfinished orders need. This release requires the companion
gateway revision recorded in
[docs/releasing.md](docs/releasing.md#gateway-compatibility).

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
- [Releasing and compatibility](docs/releasing.md)
- [Security model](SECURITY.md)
- [Scripts](scripts/README.md)

Coding agents should read `AGENTS.md`, then the portable
`.agents/skills/daski-provider/SKILL.md`. Repository documentation is
authoritative after checkout. The separately packaged skill also includes a
zero-context Daski primer plus focused references for starter selection,
product mapping, external jobs, full-provider work, and onboarding, so it
remains useful before a repository is cloned. Install it with
`npx skills add https://github.com/daski-io/provider --skill daski-provider`
([details](docs/agent-skill.md)).

## Staying current

Fork this repository and retain it as an upstream remote:

```bash
git remote add upstream https://github.com/daski-io/provider.git
git fetch upstream
git merge upstream/develop
```

Keep product code inside its service folder and review protocol/migration
changes before merging. Never edit an applied migration. Read the release's
upgrade notes before deploying it: the first upgrade from a pre-R1 image is a
stop-and-drain cutover, while later compatible releases may overlap a
running one. Replace the security contact in `SECURITY.md` with a private
channel operated by your organization.

## License

MIT. See [LICENSE](LICENSE).
