# Testnet, Mainnet, and handoff

Read this reference when preparing an onboarding packet, installing reviewed
configuration, registering a full provider, upgrading a deployed provider,
requesting Mainnet, or handing work to a human/operator.

## Keep stages separate

| Stage | What may be proven | What remains external |
| --- | --- | --- |
| Offline | Starter installation, dummy path, unit/static gates | Database, wallet, gateway, chain, product |
| Local | Product adapter, fake-client tests, local PostgreSQL, doctor | Daski artifacts, public origin, paid journey |
| Testnet | Public HTTPS runtime, reviewed Base Sepolia bindings, sandbox product, paid journey | Mainnet whitelist and production release |
| Mainnet | Reviewed production configuration and operations | Explicit Daski admission remains mandatory |

Default to Testnet. A passing local build, doctor, signed artifact, contract
deployment, or Testnet purchase does not grant Mainnet access.

## Responsibility boundary

The provider supplies legal/public identity, support, stable HTTPS origin,
service and skill contracts, product operation mapping, product credentials,
environment behavior, provider wallet/payee intent, deployment, and safe test
evidence.

Daski supplies or confirms taxonomy/listing decisions, gateway and contract
coordinates, signer/audience bindings, current signed policies/admissions, the
minimal starter's runtime bundle, the full starter's registration preparation,
and the Mainnet whitelist decision. Never invent a missing Daski value or
combine values from different revisions.

## Review packet

Prepare one concise versioned packet containing:

1. provider legal name, website, terms, privacy, support/SLA, and HTTPS origin;
2. service slug/version, description, taxonomy, jurisdictions, and turnaround;
3. each skill id, completed outcome, examples, closed input/result schemas,
   path and mode (lite synchronous, lite external job, or full), capacity,
   and deadline;
4. exact fixed price or dynamic quote behavior in atomic USDC;
5. API/MCP operation mapping and proof buyer input cannot select the target;
6. sandbox/live separation, Testnet side effects, timeout, size, concurrency,
   idempotency, ambiguity, and reconciliation behavior;
7. for an external job: how the verified Daski order starts already-paid
   product work, the product's idempotency retention and lookup after a lost
   response (with the evidence for each), the adapter version, normal and
   maximum runtime, the declared fulfillment window, and report retention;
8. assets, lifecycle, ownership, actions, jobs, human input, protected data,
   retention, and redaction when applicable;
9. wallet, identity, payee, public deployment, readiness, and support posture;
10. commit/image digest, the tested starter and gateway revisions, plus local
    gate and doctor results; and
11. remaining provider, product, and Daski inputs, including any upstream
    gap in payment mapping or start recovery.

Checked-in service contracts, docs, and tests are the technical source. Do not
maintain an untracked second specification that can drift.

## Minimal-provider Testnet boundary

The minimal starter does not self-register or send chain transactions. Daski's
reviewed onboarding flow supplies a completed runtime bundle and the matching
policy, signer, audience, identity, contract, evidence, and splitter bindings.

Installing a reviewed bundle is a provider-database mutation and requires
explicit authority for the intended database and file:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The importer verifies both signatures, local contract hashes and prices,
provider intent, runtime commitment, policy, and splitter provenance before an
append-only atomic promotion. Never edit, recompress, merge, resign, or store
the bundle in Git or ordinary support messages.

An external-job service also needs `PROVIDER_DATA_ENCRYPTION_KEY` in the
secret manager and the operator's `npm run daski:async-admission --
--activate`, another database mutation that needs explicit authority; its
read-only form (no flag) reports the prerequisite checks first.

## Full-provider Testnet boundary

The full starter prepares and self-registers its reviewed service contracts.
Its `daski:register` command can sign, write to chain, and mutate gateway and
catalog state. Before running it, require explicit authorization for the exact
Testnet gateway, chain, wallet, service set, transaction costs, and prepared
changes. Persisted/reconciled registration is not a generic setup step.

For both starters, exercise discovery, invalid and boundary input, successful
purchase, terminal evidence, same-dispatch replay, changed replay rejection,
product outage/timeout, idempotency/ambiguity, readiness failure/recovery, and
restart behavior through the real Daski Testnet gateway. For a lite external
job, also a restart while the job is pending, a lost start answer recovered
by the order key, and the late report read through status and artifact. A
hand-built direct provider request is not a paid end-to-end test.

## Upgrading a deployed lite provider

Distinguish the two kinds of upgrade and say which one applies:

- **Initial cutover from a pre-R1 image** (a checkout without external-job
  mode or the schema-epoch barrier): a coordinated stop-and-drain, not a
  rolling deployment. Pause sales, drain synchronous calls, stop every old
  process, run the cutover inventory (`npm run daski:cutover`), reconcile and
  resolve the interrupted pre-R1 executions it lists, install the newly
  issued bundles, start the new build, and resume sales. The old image is not
  a rollback target afterwards. Async admission stays off until an operator
  activates it explicitly.
- **Later compatible upgrade** (same schema epoch): may overlap the running
  build briefly. Retain every adapter version unfinished jobs need, every
  encryption key id stored jobs name, previous wallet keys for orders signed
  with them, and old routed URLs and audiences. While async admission is
  on, boot also refuses a build that cannot resume an adapter version a
  running instance still sells. The new build's read-only
  `doctor -- --database` run must pass `RETAINED_OBLIGATIONS`. A release that
  raises the schema epoch is another stop-and-drain cutover.

Every step that migrates, resolves, imports, or activates is an operator
action requiring explicit authority for that database; prepare it, do not
run it unasked.

## Mainnet boundary

Mainnet is not self-service. After successful Testnet review, request
whitelisting through the [Daski Discord](https://discord.gg/uyeMp7Q2HW) and
provide the proposed immutable release commit/image plus redacted evidence.

Before Mainnet, remove dummy, use a separate production wallet/database/origin/
product account/secrets set, refuse sandbox modes, use the reviewed Mainnet
artifact set, pass production security/readiness gates, and establish support,
monitoring, incident, backup, and recovery procedures. No skill instruction,
environment flag, doctor result, or signed file bypasses coordinated approval.

## Safe evidence

Retain commit/image digest, deployment revision, stable doctor codes,
non-sensitive request ids, public chain coordinates, and redacted results. Do
not retain or transmit `.env`, wallet keys, API tokens, signed authorizations,
buyer payloads, raw product responses, database dumps, or supplier account
details.

## Handoff template

```markdown
Path, mode, and supporting facts:
Repository/ref, package version, and deployment stage:
Tested gateway revision:
Product-to-service/skill mapping:
Payment mapping and start-recovery evidence (external job):
Fulfillment window, runtime, and report retention (external job):
Implemented files/contracts and adapter version:
Retained versions, keys, URLs, and audiences for outstanding orders:
Upgrade kind (initial pre-R1 cutover or later compatible upgrade):
Checks run and results:
Doctor stage and stable codes (offline and --database):
Testnet journey evidence:

Provider-owned inputs still needed:
Product-owned inputs still needed (unresolved product facts):
Daski-owned inputs still needed:
Explicit authorizations still needed:
Known assumptions or risks:
Next safe action:
```

Clearly label what is locally complete, what Daski has admitted on Testnet, and
what remains blocked on Mainnet review. Do not describe an unperformed external
action as complete.
