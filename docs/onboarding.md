# Testnet and Mainnet onboarding

Daski admission is a coordinated product and protocol review. Code that runs
locally is not automatically listed, and a signed artifact does not grant
Mainnet access.

Start on Testnet. Mainnet is separately whitelisted through the
[Daski Discord](https://discord.gg/uyeMp7Q2HW).

## Shared vocabulary

| Term | Meaning |
| --- | --- |
| Provider | Your organization, runtime, ERC-8004 identity, and provider wallet |
| Supplier | The upstream API, MCP server, or product, even when provider-owned |
| Service | One coherent public product boundary |
| Skill | One buyer-visible fixed operation |
| Runtime listing | Reviewed listing/payment coordinate for a skill |
| Gateway | Daski entrypoint that admits payment and signs provider calls |
| Signed binding | Daski-issued/reviewed runtime listing, signer, audience, contract, and evidence configuration |

## Choose the repository and mode before review

Use this repository for fixed-price, fully automated operations in one of two
modes: synchronous (a terminal result within the 50-second synchronous
budget) or external job (the product already runs the paid work as its own
job; core admits it durably, starts it under a stable key, recovers a lost
start by that key and polls it until its report, sized to the declared
fulfillment window and past it as overdue work). Use
[provider-full](https://github.com/daski-io/provider-full) for dynamic
pricing, provider-owned multi-step workflows, later input, cancellation,
assets/actions, human review, email, admin, direct A2A, or multi-replica
execution. A long runtime alone does not require `provider-full`, and
neither repository can make a start safe that the product cannot reconcile.

Changing starters or a service's mode after artifact issuance changes the
fulfillment contract and requires renewed review.

## Who supplies what

| Provider supplies | Daski supplies or confirms |
| --- | --- |
| Legal/public identity, terms, privacy, support, website, HTTPS origin | Current marketplace legal links and onboarding channel |
| Service/skill descriptions, exact input schema, fixed price, examples, artifacts, timing, and tests | Taxonomy and listing decision |
| Fixed API/MCP operation mapping, product modes/credentials, idempotency, reconciliation, readiness, and operations | Gateway origin/signer and standard-rail environment |
| Dedicated provider wallet, intended ERC-8004 identity, payee, and controlled-wallet facts | Current identity/evidence/contract coordinates and registration procedure |
| Deployed candidate and successful end-to-end Testnet evidence | Reviewed global policy/runtime bundles and Mainnet whitelist decision |

The provider owns product credentials and operation. Daski owns marketplace
admission and its signed bindings. Do not invent a missing Daski value.

## Prepare the review packet

Send a concise versioned packet containing:

1. provider legal name, website, terms, privacy notice, support contact/SLA,
   and intended public HTTPS origin;
2. service slug/version/name/description, category family, proposed service
   type, jurisdictions, and turnaround;
3. each skill id, plain-language outcome, examples, required/optional fields,
   exact bounds, and JSON Schema;
4. exact fixed price in atomic USDC, capacity, and deadline;
5. terminal artifact schemas and stable failure codes;
6. API origin/endpoint/method or MCP server/transport/tool mapping, with proof
   that buyer input cannot select them;
7. product fake/sandbox/Testnet/live separation and every possible Testnet
   side effect or upstream charge;
8. timeout, response-size, concurrency, idempotency, ambiguity, and
   authoritative reconciliation behavior;
9. for an external job: how Daski's verified payment starts an already-paid
   product job (never a second purchase), the product's idempotency
   retention, its lookup by order key after a lost response, its states and
   poll limits, normal and maximum runtime, the declared fulfillment window,
   report retention and the adapter version;
10. data sent to the product, retention, redaction, and support evidence;
11. provider wallet/identity/payee and other provider-controlled wallets; and
12. commit/image identifier, the tested gateway revision and local gate
    results.

The checked-in service docs, schemas, and tests are the packet's technical
source. Do not maintain a second private specification that can drift.

## Testnet process

### 1. Implement locally

Replace the dummy following [Adding a service](adding-a-service.md). Use a
fake product client in unit tests and a separately configured product sandbox
for Testnet. If the sandbox can create real records or charges, document and
strictly bound the campaign before connecting it.

Run every local gate. In synchronous mode, do not proceed when a product
ambiguity, timeout, or result can outlive the 50-second synchronous budget;
move such a product job to external-job mode once its start can be
recovered by the order key.

### 2. Establish identity and public origin

Choose a dedicated Base Sepolia provider wallet and intended ERC-8004 identity.
Fund only bounded Testnet needs; use Base's official
[faucet directory](https://docs.base.org/base-chain/network-information/network-faucets).
Keep the key in an approved secret manager.

Deploy one active application replica at a stable HTTPS origin. Provider and
gateway audiences are signed exact strings, so a localhost/tunnel URL and the
later production URL are not interchangeable.

This minimal starter has no chain-mutating registration script. Follow the
identity registration/binding procedure and tooling confirmed by Daski. Review
the chain, contracts, signer, origin, wallet, and cost before authorizing any
transaction.

### 3. Receive and install one consistent binding set

Install the reviewed Base Sepolia chain/identity coordinates, gateway signer
and audiences, provider audience, signed global rail policy,
evidence/reputation contracts, control-profile hash, and one runtime bundle per
service exactly as supplied. Never combine revisions, hand-edit an envelope or
bundle, or weaken validation.

The reviewed Daski onboarding flow obtains provider-wallet authorization before
issuing the completed bundle. Keep that authorization and the bundle out of Git
and support messages. This repository does not register identity or send chain
transactions.

With the reviewed environment configured and PostgreSQL reachable, install each
bundle from a protected operator path:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The importer verifies signatures, exact local contract hashes and price,
runtime commitments, global policy, and splitter provenance before one atomic
catalog promotion. An identical retry is safe. Any mismatch requires a new
bundle from Daski, not a local edit.

### 4. Run staged diagnostics

```bash
npm run doctor -- --stage=testnet
npm run doctor -- --stage=testnet --database
```

Fix every failure. The `--database` run reads the deployment database
read-only: the schema epoch, the installed runtime catalog against the
installed paid skills, retained obligations and, for external jobs, the
async-admission switch and running workers. Then boot the deployed provider
and verify that `/health/ready` reports `reads` ok and `admission` open,
discovery documents, public legal/support fields, installed service/skill
ids, and `/standard-rail/outcomes` against the reviewed packet.

Doctor is local and read-only. It does not prove the external listing,
whitelist, wallet balance, public reachability, or a paid journey.

### 5. Exercise the real Testnet journey

Through the Daski gateway, test at least:

1. provider/service discovery;
2. malformed and boundary input rejection before product execution;
3. one successful fixed quote and paid dispatch;
4. terminal artifact and provider attestation;
5. same-dispatch replay returning the durable result;
6. changed request/dispatch replay rejection;
7. product timeout/outage and safe public failure;
8. product idempotency and authoritative ambiguity reconciliation, when
   mutating;
9. process crash with an active request, verifying it fails terminally once
   its execution lease expires (`provider_execution_abandoned`) and is not
   blindly re-executed, and that a restart does not fail another process's
   live call;
10. readiness failure/recovery for database, identity, rail, and product;
    and
11. for an external job: the funded dispatch answered `submitted` without
    the dispatch handler calling the product, a restart while the job is pending (no second start), a
    lost start answer recovered by the order key, and the report read
    through status and artifact after it completes.

Do not call the provider dispatch endpoint directly with invented envelopes as
a substitute. A valid journey includes the real gateway and reviewed Base
Sepolia contracts/evidence.

### 6. Capture safe evidence

Retain commit/image digest, deployment revision, doctor codes, non-sensitive
request ids, public chain coordinates, and redacted results. Do not retain or
share `.env`, wallet keys, API tokens, buyer payloads, signed authorizations,
raw product responses, or database dumps.

## Testnet completion criteria

- Clean-clone install and every CI/release gate pass.
- No dummy or provider-specific secret/example remains in the real path.
- Deployed readiness and discovery match the packet.
- The product operation stays inside its mode's fit.
- Paid success, replay, failure, outage, and restart cases pass.
- Daski confirms Testnet review completion.

## Mainnet whitelist

Mainnet is not self-service. Ask through the
[Daski Discord](https://discord.gg/uyeMp7Q2HW) and provide Testnet evidence plus
the proposed immutable release commit/image.

No local flag, doctor result, contract deployment, signed artifact, or
successful Testnet payment can grant Mainnet admission. Doctor deliberately
emits `MAINNET_WHITELIST_REQUIRED` because this manual external decision cannot
be machine-proven.

Before Mainnet:

- remove `src/services/dummy` and obtain a real-service runtime bundle;
- use Base chain id `8453` with `NODE_ENV=production`;
- use canonical reviewed contracts/USDC and a new Mainnet artifact set;
- create separate Mainnet wallet, PostgreSQL, product account, RPC, origin,
  secrets, monitoring, and support/incident process;
- make every service incapable of selecting fake/sandbox/Testnet mode;
- use verified database TLS and separate runtime/migration principals;
- verify reverse-proxy CIDRs and edge rate limiting;
- operate one active instance and prove failure/recovery behavior;
- run `npm run doctor -- --stage=mainnet` and every release gate; and
- obtain explicit Daski whitelist/coordinated release approval.

## Upgrading a pre-R1 deployment (stop-and-drain cutover)

The first upgrade from a released pre-R1 image (any `0.1.x` build; R1 is
`0.2.0`, see `docs/releasing.md`) is a coordinated cutover, not a rolling
deployment: an old process already in a product call cannot be made
safe by fencing its later write, and the old image fails every executing row
whenever it boots. Hand this sequence to the operator:

1. Pause new sales: ask Daski to pause the listings (or stop quoting), so no
   new paid order arrives during the change. Funded orders remain owed.
2. Drain: wait at least 50 seconds (the synchronous budget) plus margin after
   the last dispatch so in-flight calls finish.
3. Stop every pre-R1 process, including any that a supervisor would restart.
4. Run `npm run daski:cutover` with the R1 build and the production
   configuration. It applies the R1 migrations, which install the
   legacy-process barrier (from then on no pre-R1 process can boot or change a
   row), and prints the inventory as JSON: schema epoch, pre-R1 executions
   left `executing` (opaque task ids), leased R1 executions, and unresolved
   supplier operations (core's own external-job start entries excluded).
5. For each listed pre-R1 execution, reconcile any supplier mutation it may
   have made with the product (authoritative lookup; never repeat it blindly).
   Then run `npm run daski:cutover -- --resolve-legacy --old-processes-stopped`
   to fail them as the old image would have (`provider_restarted_during_execution`).
   Rows younger than 120 seconds are left for a later run. No input or job
   handle is invented for them.
6. Install the newly issued R1 runtime bundles (`npm run daski:install-runtime`):
   R1 changes every published skill contract, so until they are installed the
   old listings stay stopped for new quotes (`contract_drift`) while their
   orders are serviced.
7. Start the R1 build, check `/health/ready`, then resume sales.

The pre-R1 image is not a rollback target afterwards: a rollback is a tested
compatible R1 image on the same schema, or R1 servicing with new sales off.

### Enabling external jobs

The cutover leaves async admission off, and no migration, import or boot
turns it on. To sell an external-job service after the cutover:

1. Generate `PROVIDER_DATA_ENCRYPTION_KEY` (32 random bytes, `0x` hex) in the
   secret manager and give every replica the same key and key id.
2. Install the service's newly issued runtime bundle and start the build on
   every replica; each process runs the external-job worker.
3. Run `npm run daski:async-admission` and review its read-only checks
   (barrier, no pre-R1 execution left, retained obligations, compatible
   running workers, an active key, adapter versions), then
   `npm run daski:async-admission -- --activate`.
4. Check that `/health/ready` reports `admission` open, then quote through
   the Daski Testnet gateway.

`--deactivate` stops new external-job quotes, and it also refuses (before
admission, retryably) a funded external-job dispatch that was not admitted
yet: the gateway re-dispatches such an order until its fulfillment horizon,
so it is admitted only if the switch is back on by then. Admitted jobs keep
being serviced and read. To stop selling without stranding a paid order,
ask Daski to pause the listings first and deactivate only once the open
quotes (120 seconds) and their first dispatches have settled.

### Later compatible upgrades

After the cutover, compatible releases at the same schema epoch may overlap
the running one briefly; leases and fences keep each call single and a
restart resubmits nothing. Before rolling one out:

- keep every adapter version an unfinished job or a quote that may still be
  dispatched needs (a quote's order runs with the version that sold it), as
  the current adapter or in `previousExternalJobAdapters` (while async
  admission is on, boot also refuses a build that cannot resume a version a
  running instance sells); a rollback build needs the version the newer
  build sold with too, until the quotes it sold pass the first-dispatch
  bound (their `validBefore` plus 31 days);
- keep every encryption key id stored jobs name
  (`PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS`), every previous wallet key
  orders were signed with (`PROVIDER_RETAINED_WALLET_PRIVATE_KEYS`), every
  old audience still routed (`STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES`) and
  every previous control profile quotes were issued under
  (`STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES`);
- run `npm run doctor -- --stage=testnet --database` with the new build's
  configuration: `RETAINED_OBLIGATIONS` must pass; and
- read the release notes: a release that raises the schema epoch is a new
  stop-and-drain cutover, not an overlap.

Boot and the importer refuse a build that cannot service an obligation
(`docs/configuration.md`), so an incompatible build cannot take over.

## Changes requiring renewed coordination

Contact Daski before changing a reviewed origin/audience, gateway signer,
provider identity/wallet/payee, service/skill/runtime-listing id,
request/artifact schema, fixed price, capacity, deadline, commission,
contract/evidence binding, API/MCP operation, or fulfillment guarantee. Request
one new complete policy/bundle set and retest it on Testnet before promotion.

This release changes every published skill contract: it adds the gateway's
required `purchaseReadiness: null`, always publishes both deadlines with the
recoverable defaults `{dispatchSeconds: 300, fulfillmentSeconds: 900}`, and
corrects the dummy `echo` result schema to the complete result its adapter
returns (`skillContractHash` `0xdf0ac577…7a1f` becomes `0x4efd0a11…7f17`).
Every installed listing therefore needs a newly issued runtime bundle through
the normal review; the importer refuses an old bundle for the new build, and
a running provider logs listing commitment drift and stops new quotes for
those listings (`contract_drift`) until the new bundle is installed, while it
keeps servicing their orders. Never edit or re-sign an issued bundle to match.
