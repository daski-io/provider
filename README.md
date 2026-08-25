# Daski Provider Starter

This repository is the starting point for organizations that want to sell a
service through [Daski](https://daski.io). It provides the provider-side
protocol, payment, identity, security, persistence, and operator foundations so
you can concentrate on the service you fulfill.

The repository is intentionally generic. It contains no production supplier
integration, private screening policy, or provider-specific offering. The only
service is `src/services/dummy`, a small reference implementation that must be
replaced before a mainnet deployment.

## Who this is for

Use this repository if you are a Daski service provider, integration partner,
or engineering team preparing an offering for the Daski marketplace. You
should be comfortable operating an HTTP service, PostgreSQL, an EVM wallet, and
any external suppliers your product depends on.

This is not a buyer SDK, a standalone marketplace, or a payment simulator.
Buyer agents normally discover and purchase your outcome through the Daski
gateway.

## What is included

| Area | What the starter provides |
| --- | --- |
| Discovery | ERC-8004 registration metadata, A2A AgentCards, skill docs, and `llms.txt` |
| Orders | Quote, dispatch, status, lifecycle, and evidence endpoints for the standard Exact-EVM rail |
| Ownership | Wallet-authorized asset ownership and reviewed asset actions |
| Fulfillment | A typed `ServiceModule` contract, adapter lifecycle, durable jobs, and supplier-operation journal |
| Operations | Health/readiness routes, admin API/UI, reviews, email hooks, retention, and structured logging |
| Security | Signed-request binding, replay ledgers, protected-data encryption, SSRF controls, rate limits, and fail-closed startup checks |
| Example | A free `echo` skill and a paid `create-note` skill with co-located tests and docs |

The active payment path is the Daski standard Exact-EVM rail. Legacy payment
routers and alternate native payment paths are not part of this starter.

## How a Daski order reaches your service

1. Your service manifest and skill definitions are published through the
   provider's discovery endpoints.
2. Daski asks the provider for a quote. Your adapter validates the request and
   returns the exact USDC amount or structured field errors.
3. The gateway issues and verifies the standard payment requirements.
4. The gateway sends a signed, order-bound dispatch to this provider.
5. Core verifies the signer, audience, recipe, request hash, payment evidence,
   and replay state before your adapter runs.
6. Your service fulfills the request and returns artifacts and, when
   applicable, a newly provisioned asset.
7. The provider exposes durable status/evidence and submits the terminal
   outcome to the standard reputation contract.

Your service code never decides whether a payment is valid. It receives an
already admitted task through the core boundary.

## Before you start

You need:

- Node.js 24 and npm;
- PostgreSQL 16 or newer;
- a dedicated Base Sepolia provider wallet with Testnet ETH;
- a public HTTPS origin for the running provider;
- current Testnet contract coordinates and signed standard-rail artifacts from
  [Daski provider onboarding](https://daski.io/providers); and
- supplier sandbox credentials, if your replacement service calls a supplier.

A full server will not boot from placeholder configuration. This is deliberate:
the provider validates its identity, catalog, gateway signer, contracts, and
signed outcome/action sets before listening.

Daski onboarding reviews your service and supplies a mutually consistent set of
public Testnet coordinates and signed outcome, servicing-admission, and
asset-action artifacts. Providers do not generate or edit those artifacts.
Start at the [provider page](https://daski.io/providers), or use the
[Daski Discord](https://discord.gg/uyeMp7Q2HW) if you need an onboarding
contact.

## Testnet-first quickstart

Clone and install:

```bash
git clone https://github.com/daski-io/provider.git
cd provider
nvm use
npm ci
cp .env.example .env
```

Before configuring a database, wallet, or contracts, exercise the bundled
reference adapter locally:

```bash
npm run try-skill -- dummy echo '{"message":"Hello, Daski"}'
npm run try-skill -- dummy create-note '{"title":"First note","body":"Hello"}'
```

This command deliberately works only with `dummy`. It invokes that adapter in
memory and prints the quote, result, and skill documentation. It does not
perform gateway admission, payment verification, persistence, supplier calls,
or chain writes, so it is a learning aid rather than an integration or
security test. Real services should be exercised through their co-located
tests and then through the Testnet gateway.

Create a local PostgreSQL database:

```bash
createdb daski_provider
```

Edit `.env`. Start with Base Sepolia (`CHAIN_ID=84532`) and
`CHAIN_MODE=live`. Replace every `REPLACE_*` value and copy the signed
artifacts supplied during Daski onboarding without modifying them.

Before attempting a network boot, verify the repository:

The template shows the variables every deployment must consider. Less common
tunables and their safe defaults are documented inline in `src/core/config.ts`.

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run test:run
npm run build
```

Then start the provider:

```bash
npm run dev
```

`npm run dev` and `npm start` load a local `.env` using Node's native
environment-file support. Deployment platforms may inject the same variables
directly instead.

Check readiness:

```bash
curl http://127.0.0.1:4000/health/live
curl http://127.0.0.1:4000/health/ready
```

Liveness only proves the process is running. Readiness proves required
database, worker, identity, catalog, and standard-rail checks are current.
Route production traffic only when `/health/ready` succeeds.

### Provider registration

Provider onboarding establishes one ERC-8004 provider identity and the Daski
marketplace registration used by all of your services. After Daski confirms
the Testnet coordinates and your `BASE_URL` is a stable public HTTPS origin,
build and run:

```bash
npm run build
node --env-file=.env scripts/register-provider.mjs
```

This command writes to Base Sepolia: it can register the agent, bind the
verified wallet, claim the Daski index entry, and pay the marketplace listing
fee. Review its environment and fund the Testnet wallet before running it. Put
the resulting agent id in `PROVIDER_AGENT_ID`.

The provider reconciles each installed service with `ServiceRegistry` at
boot. Do not confuse the provider agent id with a service id: one provider can
publish many versioned services.

## Local provider, gateway, and contracts

The recommended development topology runs the provider and, when needed, a
local checkout of the gateway as local processes while both verify the current
Base Sepolia contracts and signed Testnet artifacts:

- provider: [daski-io/provider](https://github.com/daski-io/provider);
- gateway: [daski-io/gateway](https://github.com/daski-io/gateway);
- contracts: [daski-io/contracts](https://github.com/daski-io/contracts).

Use a TLS reverse proxy or development tunnel when either process must be
addressed by its signed public audience. The gateway and provider must agree on
origins, signer bindings, outcome ids, service/skill ids, and hashes.

The contracts repository can be built and tested locally with Foundry. Runtime
integration should still point at the reviewed Base Sepolia deployment unless
you are deliberately developing the protocol itself.

There is no fake local facilitator. The gateway always runs the standard rail
and rejects mock-chain payment configuration. A fully private chain therefore
requires a complete, internally consistent contract deployment, facilitator,
signer set, and newly signed artifacts; it is an advanced protocol-development
path, not the provider quickstart.

`CHAIN_MODE=mock` exists only for bounded provider-side testing. It binds the
provider to loopback and requires an explicit mock buyer wallet, but it does
not remove the standard-rail artifact requirements and cannot stand in for a
paid gateway integration.

## The dummy service

`src/services/dummy` demonstrates the smallest useful service module:

| Skill | Price | Demonstrates |
| --- | --- | --- |
| `echo` | Free | input validation, immediate execution, and an artifact |
| `create-note` | 0.10 USDC | quote validation, paid dispatch, collision-safe asset identity, and asset provisioning |

The service has no supplier, custom database table, private policy, background
worker, or wallet asset action. Its tests live in
`src/services/dummy/tests`, next to the behavior they cover.

The paid skill's reviewed outcome id is `dummy-create-note`; outcome ids and
skill ids are intentionally separate concepts. The outcome must still be
admitted in the signed Testnet artifacts before a real purchase can occur.

Boot fails on Base mainnet while the dummy service is installed.

## Build your service

Start with [the complete service guide](docs/adding-a-service.md). The short
version is:

1. Copy `src/services/dummy` to `src/services/<your-slug>`.
2. Rename its exports and replace the manifest, skills, validation, adapter,
   docs, and tests.
3. Put service-specific configuration in that service's `config.ts` and
   validate it at startup. Never put credentials in a manifest or log.
4. Add service-owned migrations, seeds, workers, readiness checks, protected
   data sinks, routes, or admin extensions only when your service needs them.
5. Register the module once in `src/providerServices.ts`.
6. Replace the dummy outcome in `src/providerLaunchPolicy.ts` with the exact
   outcome/action set reviewed during Daski onboarding.
7. Remove `src/services/dummy` and its offline `try-skill` command when it
   is no longer useful, then prove the genericity and composition tests still
   pass.
8. Deploy to Testnet, exercise free and paid paths through the gateway, and
   review durable evidence before considering mainnet.

### The ServiceModule boundary

A service exports one `ServiceModule`:

- `manifest`: public service identity, taxonomy, lifecycle, and defaults;
- `skills`: buyer-visible actions, fields, pricing, and access metadata;
- `fulfillment`: quote/execute/input/cancel adapter and optional pre-execute
  review;
- `protocol`: service/skill docs plus optional routes and inbound email;
- `operations`: optional migrations, seed, workers, and readiness;
- `agents`: optional bounded email/operator tools;
- `security`: optional redaction, encryption rotation sinks, and protected
  asset identifiers;
- `assets`: optional identity, lookup-state, and ownership behavior;
- `screening`: optional subject extraction against an independently installed
  provider policy; and
- `admin`: optional service-specific operator controls.

`src/core` never imports a service. Services may import core contracts, but
must not import sibling services or private provider extensions. The
composition files at `src/` are the only place those concerns meet. ESLint and
the architecture gate enforce this boundary.

### Quotes and fulfillment

`quote()` runs before payment. Validate every buyer-controlled field and
return either an exact atomic-USDC amount or structured errors. Revalidate
inside `execute()`; quote validation is not authorization.

If fulfillment changes an external supplier, journal intent before any
non-convergent mutation. On a timeout or ambiguous response, reconcile
authoritative supplier state before retrying. Never guess whether an external
write succeeded.

Return a new `asset` block only for first-time provisioning. Existing assets
are mutated in place. Ownership comes from the wallet-authorized payer, never
from an order id or a caller-supplied address.

### Paid outcomes and asset actions

Every paid outcome is named in `src/providerLaunchPolicy.ts`. The configured
signed outcome set must match that allowlist exactly.

Owner-only asset actions also require a signed servicing admission and action
catalog. Destructive actions require a reviewed classification, a delayed
second wallet authorization, and adversarial replay/mismatch tests. Do not add
a service-local signature scheme or bypass core wallet authorization.

Changing an outcome or action is a coordinated Testnet onboarding/release
change, not just a code edit.

### Protected data

Collect only fields required for fulfillment. Use the core encryption envelope
for protected values, declare rotation sinks for service-owned storage, and
redact sensitive fields before logs, prompts, reviews, public errors, or
artifacts. Do not commit customer data, supplier account data, private policy,
runtime output, or credentials.

## Tests and quality gates

Service-owned tests belong under
`src/services/<slug>/tests`. Keep `test/` for core and genuinely
cross-service contracts.

Operator and CI helpers are catalogued with their prerequisites and mutation
risks in [`scripts/README.md`](scripts/README.md).

| Command | Purpose |
| --- | --- |
| `npm run test:run` | Complete unit suite; no live database or chain required |
| `npm run test:coverage` | Global coverage gate |
| `npm run test:critical-coverage` | Per-file security-critical coverage |
| `npm run test:mainnet-readiness` | Production config and composition fail-closed checks |
| `npm run typecheck` | Application TypeScript |
| `npm run typecheck:test` | Test TypeScript |
| `npm run lint` | ESLint import zones, cycles, and code rules |
| `npm run lint:architecture` | Static architecture/security invariants |
| `npm run security:audit` | Dependency audit |
| `npm run build` | Clean production compilation and asset copy |

PostgreSQL-backed migration/security scripts are also available for CI and
release verification. They require explicit disposable database URLs and must
never target a shared or production database.

## HTTP surfaces

- `/health/live` and `/health/ready`
- `/.well-known/agent.json` and
  `/.well-known/agent-registration.json`
- `/agent-cards/<slug>.json`, `/skills/*`, and `/llms.txt`
- `/standard-rail/*`
- `/a2a/:serviceSlug` — JSON-RPC `SendMessage` for admitted open free
  work and `GetTask` for polling; streaming, task listing, cancellation, and
  push-configuration methods are not implemented
- `/admin/ui/*` and `/admin/*`
- `/webhooks/postmark/*`

Service-specific routes are mounted by the service's `protocol.routes`
facet.

## Deployment

The included Dockerfile is the canonical production artifact. It builds a
non-root Node 24 runtime that can run on any OCI-compatible container
platform.

The upstream starter intentionally ships no hosting-vendor descriptor.
Provider forks may add deployment configuration maintained for their chosen
platform.

Every deployment must:

- run at least one continuously available provider process while services are
  active;
- inject configuration and secrets at runtime rather than baking them in;
- provide stable HTTPS ingress at `BASE_URL` and durable PostgreSQL 16 or
  newer, with verified database TLS in production;
- expose `PORT` and route traffic only when `/health/ready` succeeds; and
- allow the outbound HTTPS and Base RPC connections required by the gateway,
  contracts, and installed suppliers.

Set optional `DEPLOYMENT_REVISION` to a public commit, tag, or build
identifier when you want it included in the health summary. Provider-specific
deployment descriptors belong in the provider fork, not in this starter.

Testnet is the first deployment target. Keep `CHAIN_ID=84532`, use a
dedicated Testnet wallet and supplier sandbox, and run end-to-end purchases
through the Daski gateway. Mainnet requires a separate security/release review,
production database roles and TLS, edge/proxy controls, live supplier
readiness, and removal of the dummy service.

## Staying current

Fork [daski-io/provider](https://github.com/daski-io/provider) when possible
instead of copying the files without history. A fork retains upstream lineage
for protocol and security updates:

```bash
git remote add upstream https://github.com/daski-io/provider.git
git fetch upstream
git merge upstream/develop
```

Keep provider-specific work concentrated in `src/services/`, the root
composition files, your optional `src/providerExtensions/` implementations,
environment configuration, and deployment files. Review upstream changes
before merging, resolve schema and policy changes deliberately, and rerun the
complete quality gates plus Testnet purchases. Never overwrite an applied
migration to make an update merge cleanly.

After forking, replace the vulnerability-reporting destination in
[`SECURITY.md`](SECURITY.md) with a private channel operated by your
organization.

## Working with coding agents

[`AGENTS.md`](AGENTS.md) is the repository's authoritative guide for coding
agents. Ask an agent to read it before making changes, keep service tests and
docs beside the service, and record durable decisions in repository
documentation. An agent must not bypass readiness, weaken signed-artifact
validation, fabricate onboarding artifacts, or run mutating operator scripts
against shared environments to make a task appear complete.

## Documentation

- [Adding a service](docs/adding-a-service.md)
- [Architecture](docs/architecture.md)
- [Service and skill authoring](docs/daski-skill-creation-best-practices.md)
- [Service taxonomy](docs/service-taxonomy.md)
- [Protocol cheatsheet](docs/protocol-cheatsheet.md)
- [Standard-rail evidence V2](docs/standard-rail-evidence-v2.md)
- [Security model](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Operator and CI scripts](scripts/README.md)

## License

MIT. See [LICENSE](LICENSE).
