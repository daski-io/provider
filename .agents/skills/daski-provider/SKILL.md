---
name: daski-provider
description: Choose, acquire, build, diagnose, and onboard the correct Daski provider starter and mode (lite synchronous, lite external job, or provider-full) for an existing API, MCP, SDK, or job-running product. Use for provider-side service integration and Testnet/Mainnet preparation; do not use for Daski buyer clients or unrelated API/MCP gateways.
license: MIT
metadata:
  version: "0.2.0"
---

# Daski provider

Help an organization expose an existing product through Daski without weakening
payment, replay, identity, network, ownership, or product boundaries. This
portable package must work before or after a provider repository is cloned.
Installing or invoking it does not authorize deployment, signing, spending,
registration, live product calls, database changes, pushes, or releases.

## Route the work

Read only the references needed for the current task, completely when selected:

- No prior Daski knowledge: [Daski primer](references/daski-primer.md).
- No checkout yet, an older checkout, an uncertain path, or a first
  installation: [Start here](references/start-here.md).
- Mapping an API, MCP server, SDK, job API, or internal product:
  [Integration brief](references/integration-brief.md).
- A product that already runs the paid work as its own job:
  [External jobs](references/external-jobs.md).
- Any full-starter capability is required:
  [Full-provider workflow](references/provider-full.md).
- Preparing Testnet, Mainnet, an upgrade, a review packet, or a human
  handoff: [Onboarding and handoff](references/onboarding-handoff.md).

After checkout, read that repository's `AGENTS.md` completely before acting.
Its `README.md`, `SECURITY.md`, and `docs/` are authoritative for the checked-out
revision; do not substitute this summary or remembered Daski behavior for the
actual contracts. An installed copy never updates itself; refresh it with
`npx skills add https://github.com/daski-io/provider --skill daski-provider`.

## Establish context and authority

1. Identify whether the user supplied an existing fork, a clean starter, or no
   repository. Preserve unrelated working-tree changes.
2. Classify the request as explanation, diagnosis, implementation, local
   verification, onboarding preparation, or an external mutation. A request to
   review or build does not imply authority to deploy, register, sign, spend,
   call a live product, migrate shared data, push, tag, or release.
3. Identify the stage: offline, local, Testnet, or Mainnet. Default new work to
   offline/local followed by Testnet; never default to Mainnet.
4. Obtain only safe product documentation and schemas. Never request or place
   credentials, wallet keys, `.env` files, signed artifacts, customer data, or
   raw production responses in prompts, source, tests, or support messages.

## Check the checkout's capabilities

Inspect what the checked-out revision provides before proposing an API that
it lacks. In `provider`, external-job mode exists only when
`src/core/serviceRegistry/adapterTypes.ts` declares `ExternalJobAdapter`
(package version 0.2.0 or later). Compare this package's `metadata.version`
with the checkout's `package.json` and report a mismatch. If the checkout
predates external jobs, select a compatible released revision or report the
upgrade requirement; never invent asynchronous methods in an older starter.

## Choose the path before editing

| Path | Required fit |
| --- | --- |
| Lite synchronous (`provider`) | Fixed price; automated terminal result within the 50-second synchronous budget; no later buyer, asset, or operator workflow; no mutation ambiguity left unresolved when the call ends. |
| Lite external job (`provider`) | Fixed price; the product already owns the long-running execution; prompt start, lookup, and poll calls; a durable job reference; safe start recovery; a report that fits the declared result schema. No later buyer input, cancellation, assets, or operator workflow. |
| Full (`provider-full`) | Dynamic pricing, provider-owned multi-step workflows, later input or cancellation, assets/actions, human or operator review, richer protected data, email/admin/direct A2A, or intentional multi-replica operation. |

Duration alone does not select `provider-full`. An x402 endpoint alone does
not prove compatibility: Daski's verified payment already bought the order.
If a lost start cannot be recovered safely, describe that upstream gap;
choosing `provider-full` does not establish whether a paid operation already
happened. Recovery after a provider-terminal paid failure is a deferred full
feature group: never promise it (overdue nonterminal work and late report
retrieval are different and supported). The repositories are alternatives,
not layers. State the selected path and its supporting product facts before
implementation.

## Map the product before writing code

Read [Integration brief](references/integration-brief.md) and produce its
operation mapping: buyer-visible outcome, fixed or dynamic price, closed input
and result bounds, one reviewed operation per skill, payment mapping,
runtime and fulfillment duration, idempotency and retention, authoritative
lookup, job states and polling, report retention, and the data boundary.
Research the product's safe documentation first and ask only for facts it
does not answer. Continue with a fake client while live facts stay listed as
missing. Never invent a paid endpoint's idempotency contract, treat a lost
response as a refusal, or test either by spending without authorization.

One Daski skill maps to one reviewed product operation. Never expose an
arbitrary buyer-selected URL, HTTP method, path, header, MCP server, transport,
tool name, schema, or credential. The upstream product is the supplier even
when the provider organization owns it.

## Implement within the selected path

Lite synchronous: copy `src/services/dummy` to `src/services/<service-slug>`;
define closed schemas, a fixed atomic-USDC price, a `resultSchema` for the
complete `ServiceResult`, and reviewed failure codes; implement `execute`
with one hard-coded operation per skill through the bounded outbound helpers,
honoring `context.signal` and the 50-second synchronous budget; journal a
non-convergent mutation and reconcile it within the call, never by a blind
retry.

Lite external job: read [External jobs](references/external-jobs.md) and copy
`src/services/synthetic-audit`. Implement the manifest, strict input
validation, the complete result schema, configuration and client, `start`,
read-only `recoverStart`, read-only `poll`, an optional read-only
`requestReadiness`, docs, and service tests. Use the `ServiceAdapter` union;
never rename or replace `FulfillmentAdapter`. The runtime supplies
persistence, the stable operation key, leases, polling, restart recovery,
retained adapter versions, and signed status and artifact reads. Any start
exception is ambiguous and reconciled by the same key, pending polls never
spend the failure budget, and an expired deadline does not prove the product
failed. Never build a private polling server, hold an HTTP request open for
the job, raise the synchronous timeout, or copy full's operator or asset
subsystems into lite.

Both lite modes: register the service only in `src/providerServices.ts`, test
with a fake client in `src/services/<slug>/tests/`, make no product-specific
core edits, keep PostgreSQL as the paid-state ledger, remove the examples
before Mainnet, and change contracts or prices only through a new Daski
runtime bundle.

Full: read [Full-provider workflow](references/provider-full.md), then follow
that repository's `AGENTS.md` and service guides. Do not apply lite contracts
to full jobs, assets, or lifecycle work, and do not copy lite's runtime-bundle
importer or external-job worker into full.

## Diagnose and verify

Use scripts declared by the selected repository rather than recreating their
logic. Start with the offline examples and read-only `doctor`, then run
targeted service tests and the documented typecheck, test-typecheck, lint,
architecture, documentation, unit, coverage, readiness, audit, and build
gates. Run `skill:validate` in `provider`. `npm run doctor -- --database`
reads the configured database read-only; run it only against a database the
user has authorized you to connect to.

Database smoke or migration checks must target an explicitly identified
disposable database. Report stable doctor codes and missing variable names,
never configured values. A passing build or doctor proves technical checks,
not Daski admission or Mainnet approval.

## Preserve hard stops

- Never fabricate, edit, recompress, combine, resign, or weaken validation of
  Daski-issued policies, admissions, action catalogs, or runtime bundles. Never
  edit runtime-catalog rows by hand.
- Never expose secrets, wallet keys, signed envelopes, buyer/product protected
  data, bearer job URLs, supplier account details, raw product output, or
  private policy.
- Never charge the buyer twice: no automatic payment of a public x402 or other
  paid endpoint for an order Daski admitted, and no caller-asserted
  "already paid" flag.
- Do not call a live product, mutate a shared database, register identity,
  install a bundle, activate async admission, sign an offer, fund a wallet,
  send a chain transaction, deploy, push, tag, release, retire a service, or
  change Mainnet without explicit authority for that exact action and
  environment.
- Testnet precedes Mainnet. Mainnet requires explicit Daski whitelisting through
  Discord and a coordinated release; no local flag, artifact, or test grants it.
- Never make readiness or admission permissive to unblock a fixture or deploy.
- When Daski-owned or product-owned inputs are missing, finish safe local
  work, list every missing input, and stop at the external boundary.

## Complete the handoff

Read [Onboarding and handoff](references/onboarding-handoff.md) when the work
approaches Testnet, Mainnet, an upgrade, or another operator. Report the
selected path and its supporting facts, product-to-skill mapping,
repository/revision and tested gateway revision, files changed, gates and
doctor codes, remaining provider/product/Daski inputs, authorizations still
required, and the next safe action. Separate local completion, Testnet
admission, and Mainnet approval.
