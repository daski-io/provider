# Testnet, Mainnet, and handoff

Read this reference when preparing an onboarding packet, installing reviewed
configuration, registering a full provider, requesting Mainnet, or handing work
to a human/operator.

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
   fulfillment mode, capacity, and deadline;
4. exact fixed price or dynamic quote behavior in atomic USDC;
5. API/MCP operation mapping and proof buyer input cannot select the target;
6. sandbox/live separation, Testnet side effects, timeout, size, concurrency,
   idempotency, ambiguity, and reconciliation behavior;
7. assets, lifecycle, ownership, actions, jobs, human input, protected data,
   retention, and redaction when applicable;
8. wallet, identity, payee, public deployment, readiness, and support posture;
9. commit/image digest plus local gate and doctor results; and
10. remaining provider, product, and Daski inputs.

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

## Full-provider Testnet boundary

The full starter prepares and self-registers its reviewed service contracts.
Its `daski:register` command can sign, write to chain, and mutate gateway and
catalog state. Before running it, require explicit authorization for the exact
Testnet gateway, chain, wallet, service set, transaction costs, and prepared
changes. Persisted/reconciled registration is not a generic setup step.

For both starters, exercise discovery, invalid and boundary input, successful
purchase, terminal evidence, same-dispatch replay, changed replay rejection,
product outage/timeout, idempotency/ambiguity, readiness failure/recovery, and
restart behavior through the real Daski Testnet gateway. A hand-built direct
provider request is not a paid end-to-end test.

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
Starter and reason:
Repository/ref and deployment stage:
Product-to-service/skill mapping:
Implemented files/contracts:
Checks run and results:
Doctor stage and stable codes:
Testnet journey evidence:

Provider-owned inputs still needed:
Product-owned inputs still needed:
Daski-owned inputs still needed:
Explicit authorizations still needed:
Known assumptions or risks:
Next safe action:
```

Clearly label what is locally complete, what Daski has admitted on Testnet, and
what remains blocked on Mainnet review. Do not describe an unperformed external
action as complete.
