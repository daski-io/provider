# Getting started

This guide takes a clean clone from an offline example to a provider ready for
Daski Testnet configuration. Local product development and Daski admission are
separate milestones; placeholder onboarding artifacts are expected to block a
full boot.

## Milestones

| Milestone | What works | External inputs |
| --- | --- | --- |
| Offline | Dummy adapter and unit gates | Node.js 24 |
| Local | Product code plus loopback PostgreSQL | Docker or PostgreSQL 16+ |
| Testnet | Public provider, Daski gateway, Base Sepolia paid order | HTTPS origin, wallet, Daski-issued policy and runtime bundle |
| Mainnet | Reviewed production listing on Base | Successful Testnet and Daski whitelist |

Before starting, confirm every operation is fixed-price, automated, one-shot,
and terminal within 50 seconds. Otherwise use
[provider-full](https://github.com/daski-io/provider-full).

## Prerequisites

For local work:

- Git;
- Node.js 24 and npm; and
- Docker with Compose, or a PostgreSQL 16+ database you control.

For Testnet you will also need a stable public HTTPS origin, a dedicated Base
Sepolia provider wallet, product sandbox credentials, and Daski onboarding
inputs. Base maintains the current
[Testnet faucet directory](https://docs.base.org/base-chain/network-information/network-faucets).

## 1. Clone and install

```bash
git clone https://github.com/daski-io/provider.git
cd provider
npm ci
node --version
```

The version must start with `v24.`. `npm ci` uses the committed lockfile; do
not mix initial setup with an unreviewed dependency update.

## 2. Run the offline example

```bash
npm run try-skill -- dummy echo "hello daski"
```

The result should contain a terminal `completed` result and an `echo_result`
artifact. This command invokes the adapter directly and is deliberately fenced
to `dummy`. It uses no database, wallet, gateway, chain, or payment.

Run the local quality gates:

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run skill:validate
npm run test:run
npm run build
```

These commands also need no live external system.

## 3. Create local configuration

Linux, macOS, or WSL:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Treat `.env` as a local worksheet. It is ignored by Git, but that does not make
it an approved production secret store. Replace the provider/product values you
own and leave Daski-issued fields pending until onboarding. Do not weaken
validation to make placeholders boot.

Use [Configuration](configuration.md) for every variable and ownership
boundary.

## 4. Start PostgreSQL

```bash
npm run dev:db:up
```

The included service binds PostgreSQL only to `127.0.0.1:55432` and persists
data in a named development volume. `.env.example` already contains its local
URL. If that port is occupied, update both `compose.yaml` and `.env` in your
fork.

If you manage PostgreSQL separately, create a new disposable development
database. Never point setup or smoke scripts at a shared Testnet/production
database.

The database is required only when the paid HTTP runtime boots. It is the
durable rail ledger, not a required store for your existing product data.

## 5. Run doctor

```bash
npm run doctor -- --stage=testnet
```

For JSON output suitable for an agent:

```bash
npm run doctor -- --stage=testnet --json
```

Doctor is read-only. It checks the Node release, `.env`, installed dependencies,
required variable names/placeholders, stage-specific bindings, and Mainnet
posture. It never migrates, signs, registers, funds, deploys, calls the product,
or prints configured secret values.

Before onboarding, failures naming `STANDARD_RAIL_*` or contract bindings are
expected and actionable. See [Troubleshooting](troubleshooting.md).

## 6. Map the product

Complete the fit and operation worksheet in
[Integrating an existing product](integrating-existing-product.md). In
particular, identify:

- one buyer-visible skill per fixed product operation;
- the exact input schema and fixed atomic-USDC price;
- the hard-coded API endpoint or MCP tool for each skill;
- upstream timeout, response-size, and concurrency limits;
- native idempotency and authoritative reconciliation behavior; and
- safe terminal artifacts and error codes.

If the product can remain pending, require later input, create a durable object,
or return an ambiguous mutation that cannot be resolved within the request,
stop and migrate the work to `provider-full`.

## 7. Replace the dummy

Follow [Adding a service](adding-a-service.md):

1. copy `src/services/dummy` to `src/services/<your-slug>`;
2. replace its manifest, schema, validation, adapter, docs, and tests;
3. add product-specific configuration/client modules in that folder;
4. install the module in `src/providerServices.ts`;
5. verify its published v2 AgentCard contract and fixed price; and
6. remove the dummy before Mainnet.

`npm run try-skill` remains intentionally dummy-only. Add product unit tests
with a fake client instead of changing it into a payment bypass.

## 8. Prepare Testnet

Follow [Onboarding](onboarding.md). Daski and the provider first review a
packet describing provider identity, public origin, service/skill/schema,
fixed price, execution bounds, upstream operation, idempotency, artifacts,
support, and wallet/payee.

Daski then supplies or confirms one consistent Base Sepolia set: gateway
origin/signer, provider audience, contract coordinates, identity binding,
signed global rail policy, one runtime bundle per service, and related hashes.
Copy it exactly. Do not generate, edit, combine across revisions, or resign
Daski-issued configuration.

This minimal starter intentionally contains no chain-mutating registration
helper. Daski's reviewed onboarding flow collects the provider-wallet
authorization needed for the bundle. Register or update identity only through
that designated flow.

## 9. Deploy and test end to end

Build the hosting-neutral image:

```bash
docker build -t your-provider:testnet .
```

Deploy exactly one active application replica with:

- a stable HTTPS `BASE_URL` that exactly matches the signed provider audience;
- durable PostgreSQL 16+;
- secrets injected outside the image;
- outbound access to reviewed Base RPCs and the fixed product dependency; and
- health routing based on `/health/ready`.

After installing the reviewed `.env`, promote each Daski-issued service bundle
into the deployment database from a protected operator environment:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The command changes only the provider database. It verifies the exact local
service contract, both trusted signers, runtime commitment, price, and splitter
provenance before an atomic promotion; an identical retry is a no-op. It does
not register identity, call the gateway/product, or send a chain transaction.

Run doctor again, boot the image, and inspect:

```text
/health/live
/health/ready
/.well-known/agent.json
/.well-known/agent-registration.json
/agent-cards/<service-slug>.json
/skills/<service-slug>.md
/llms.txt
/standard-rail/outcomes
```

Then use the Daski Testnet gateway for discovery, invalid-input, successful
purchase, duplicate dispatch, changed replay, terminal status, product outage,
and restart tests. A direct POST assembled by hand is not an end-to-end payment
test.

## Local gateway and contracts development

The normal local integration topology runs provider and gateway processes
locally while both use the reviewed Base Sepolia deployment:

- [provider](https://github.com/daski-io/provider);
- [gateway](https://github.com/daski-io/gateway); and
- [contracts](https://github.com/daski-io/contracts).

Use a TLS tunnel or reverse proxy when a signed public audience must address a
local process. A private local chain also needs a facilitator, signers, contract
deployment, and newly issued artifacts. That is protocol development, not a
provider installation path. `CHAIN_MODE=mock` is loopback-only and cannot prove
a paid journey.

## Stop local PostgreSQL

```bash
npm run dev:db:stop
```

This preserves data. The starter includes no destructive reset command.

## Completion checklist

- Node 24, `npm ci`, the offline example, and all local gates pass.
- The product operation fits the minimal starter and is explicitly mapped.
- PostgreSQL is durable and unreachable from the public internet.
- No dummy, secret, customer data, raw product response, or local `.env` is
  present in the release diff.
- Testnet doctor and `/health/ready` pass with one consistent artifact set.
- Discovery and fixed pricing match the reviewed packet.
- End-to-end Testnet payment, replay, failure, and restart behavior are proven.
- Daski confirms Testnet review before any Mainnet request.
