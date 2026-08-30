# Daski primer for a new agent

Read this reference when the agent or developer has no prior Daski context.
It explains the stable mental model needed to choose a starter and integrate an
existing product. The checked-out repository remains authoritative for exact
schemas, signatures, routes, and configuration.

## What Daski is

Daski is a marketplace and transaction layer through which buyer agents can
discover and purchase clearly defined service outcomes from independent
providers. A provider connects an existing API, MCP server, SDK, or internal
product to Daski through a controlled service adapter.

Daski is not a generic proxy to arbitrary APIs or MCP tools. The provider
publishes a small, reviewed contract for each operation: what the buyer may
send, what completed result is returned, how it is priced, and how it is
fulfilled. Daski coordinates discovery, admission, payment, dispatch, and
evidence around that contract.

## Participants and responsibilities

| Participant | Responsibility |
| --- | --- |
| Buyer agent | Selects a published skill, supplies contract-valid input, and purchases the outcome |
| Daski gateway | Presents admitted listings/quotes, admits payment, and sends a signed request bound to the purchase |
| Provider | Operates the Daski-facing runtime, identity, wallet/payee, service contracts, and product integration |
| Supplier/product | Performs the underlying API, MCP, SDK, or internal operation, even when provider-owned |
| Chain/payment contracts | Supply the reviewed Exact-EVM USDC payment and public evidence coordinates |

The provider owns product credentials, product operation, deployment, support,
and safe fulfillment. Daski owns marketplace admission and its signed gateway,
policy, listing, and contract bindings. Neither side should invent values owned
by the other.

## How one purchase flows

```text
buyer agent
  -> Daski discovery and quote
  -> Exact-EVM payment admission
  -> gateway-signed dispatch
  -> provider core verification and replay claim
  -> service adapter
  -> fixed API/MCP product operation
  -> durable terminal result and evidence
  -> buyer agent
```

In more detail:

1. The provider publishes an AgentCard containing a service and its closed
   skill contracts, descriptions, schemas, timing, pricing behavior, and
   provider identity.
2. Daski admits the reviewed service into a runtime listing. The minimal
   starter uses a fixed price; the full starter can validate and produce a
   bounded dynamic quote.
3. A buyer agent chooses a skill and sends input matching its closed schema.
4. The gateway admits the Exact-EVM payment requirements and produces a
   short-lived signed dispatch bound to the provider, service, skill, request,
   payer, order, audience, recipe, deadline, and payment evidence.
5. Provider core verifies those bindings and atomically claims replay state
   before any product operation runs.
6. Only then does the service adapter call its one configured API endpoint,
   MCP tool, SDK method, or internal operation.
7. Provider core persists status and the bounded result, emits the required
   terminal attestation/evidence, and returns the reviewed outcome. Replays
   must return the same durable result or fail closed on a mismatch.

The service adapter never decides whether payment is valid. It receives
already admitted context and owns only product validation and fulfillment.

## Core versus service code

The starter's core owns protocol signatures, audiences, payment/evidence
checks, replay protection, provider identity, persistence, rate limits, public
HTTP boundaries, health, and generic discovery. A provider should not fork
these rules for each product.

Each service owns its buyer-visible manifest and docs, closed input/result
schemas, product configuration and credentials, explicit operation mapping,
adapter, readiness, public error mapping, and service-specific tests. The full
starter also lets the service declare jobs, assets/actions, workers, protected
data, email/admin extensions, and supplier reconciliation.

## Essential vocabulary

| Term | Meaning |
| --- | --- |
| Provider | The partner organization plus its Daski-facing runtime, identity, and wallet |
| Supplier | The underlying product dependency, including a provider-owned API or MCP server |
| Service | One coherent product boundary visible in Daski discovery |
| Skill | One buyer-visible operation with a closed machine contract |
| AgentCard | The provider's public, hashable service/skill contract and discovery document |
| Outcome/runtime listing | The reviewed marketplace and payment coordinate for a paid skill |
| Quote | The exact USDC amount and constraints admitted before purchase |
| Dispatch | The gateway-signed, purchase-bound instruction sent to the provider |
| Task/order | Stable identities used for status, replay, and product idempotency; not credentials |
| Artifact | A bounded buyer-visible result returned by fulfillment |
| Asset | A durable buyer-owned object with later lifecycle or owner operations |
| Action | A reviewed owner-authorized operation on an existing asset |

Ownership is derived from the verified wallet-authorized payer. Buyer input,
order ids, task ids, asset identifiers, and caller metadata are never proof of
identity or ownership.

## Which starter fits

Minimal example: an existing text-analysis API accepts a bounded document,
returns a completed structured classification within 20 seconds, has one fixed
price, creates no later object, and can safely deduplicate or reconcile a
mutation before the request ends. Map it to one fixed skill in `provider`.

Full example: a media-rendering product creates a job, reports progress over
several minutes, stores a private downloadable result, accepts cancellation,
and later allows the owner to delete it. It requires `provider-full` for
durable jobs, asset ownership, lifecycle, actions, and restart recovery.

Never make an asynchronous operation appear minimal by returning `completed`
while product work continues. Never bolt full-starter durability into the
minimal core.

## Environments and admission

| Stage | Purpose |
| --- | --- |
| Offline | Learn and test the dummy adapter without database, wallet, gateway, chain, or product |
| Local | Implement against fake clients and local PostgreSQL; Daski placeholders may remain |
| Testnet | Use the reviewed Daski gateway and Base Sepolia bindings with a sandbox product |
| Mainnet | Run a separately reviewed production release after successful Testnet and explicit Daski whitelisting |

Testnet is the default external target. Mainnet is not self-service and must be
requested through the Daski Discord. No code change, local flag, signed file,
doctor result, or successful Testnet payment grants Mainnet admission.

## First useful output from an agent

Before editing code, an unfamiliar agent should produce:

1. a plain-language statement of the purchased outcome;
2. the minimal-versus-full decision and supporting product facts;
3. one service and focused skills mapped to fixed product operations;
4. missing provider, product, and Daski inputs;
5. assumptions that require human review; and
6. the next safe local step, stopping before unauthorized external mutations.

Continue with [Start here](start-here.md) when a repository is needed and
[Integration brief](integration-brief.md) before implementing the product
mapping.
