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

## Choose the repository before review

Use this minimal repository only for fixed-price, fully automated, one-shot
operations that terminally complete or fail within 50 seconds. Use
[provider-full](https://github.com/daski-io/provider-full) for dynamic pricing,
jobs, later input, assets/actions, human review, email, admin, direct A2A,
multi-replica execution, or ambiguity that must reconcile after restart.

Changing starters after artifact issuance changes the fulfillment contract and
requires renewed review.

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
8. timeout, response-size, concurrency, idempotency, ambiguity, and immediate
   authoritative reconciliation behavior;
9. data sent to the product, retention, redaction, and support evidence;
10. provider wallet/identity/payee and other provider-controlled wallets; and
11. commit/image identifier and local gate results.

The checked-in service docs, schemas, and tests are the packet's technical
source. Do not maintain a second private specification that can drift.

## Testnet process

### 1. Implement locally

Replace the dummy following [Adding a service](adding-a-service.md). Use a
fake product client in unit tests and a separately configured product sandbox
for Testnet. If the sandbox can create real records or charges, document and
strictly bound the campaign before connecting it.

Run every local gate. Do not proceed when a product ambiguity, timeout, or
result can outlive the 50-second synchronous window.

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
```

Fix every failure. Then boot the deployed provider and verify
`/health/ready`, discovery documents, public legal/support fields, installed
service/skill ids, and `/standard-rail/outcomes` against the reviewed packet.

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
9. process restart with an active request, verifying it fails terminally and
   is not blindly re-executed; and
10. readiness failure/recovery for database, identity, rail, and product.

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
- The product operation stays inside the minimal-starter fit.
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

## Changes requiring renewed coordination

Contact Daski before changing a reviewed origin/audience, gateway signer,
provider identity/wallet/payee, service/skill/runtime-listing id,
request/artifact schema, fixed price, capacity, deadline, commission,
contract/evidence binding, API/MCP operation, or fulfillment guarantee. Request
one new complete policy/bundle set and retest it on Testnet before promotion.
