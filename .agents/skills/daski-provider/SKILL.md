---
name: daski-provider
description: Choose, acquire, build, diagnose, and onboard the correct Daski provider starter for an existing API or MCP product. Use for provider-side service integration and Testnet/Mainnet preparation; do not use for Daski buyer clients or unrelated API/MCP gateways.
license: MIT
metadata:
  version: "0.1.0"
---

# Daski provider

Help an organization expose an existing product through Daski without weakening
payment, replay, identity, network, ownership, or product boundaries. This
portable package must work before or after a provider repository is cloned.
Installing or invoking it does not authorize deployment, signing, spending,
registration, live product calls, database changes, pushes, or releases.

## Route the work

Read only the references needed for the current task, completely when selected:

- No checkout yet, uncertain starter, or first installation: read
  [Start here](references/start-here.md).
- Mapping an API, MCP server, SDK, or internal product: read
  [Integration brief](references/integration-brief.md).
- Any full-starter capability is required: read
  [Full-provider workflow](references/provider-full.md).
- Preparing Testnet, Mainnet, a review packet, or a human handoff: read
  [Onboarding and handoff](references/onboarding-handoff.md).

After checkout, read that repository's `AGENTS.md` completely before acting.
Its `README.md`, `SECURITY.md`, and `docs/` are authoritative for the checked-out
revision. Use this package for routing, decisions, and non-obvious stopping
rules; do not substitute its summary or remembered Daski behavior for the
actual contracts.

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

## Choose the starter before editing

Use `https://github.com/daski-io/provider` only when every buyer operation is:

- fixed-price;
- fully automated;
- one-shot and terminal within 50 seconds;
- free of later buyer input, cancellation, or owner action;
- free of durable private asset or lifecycle management; and
- able to resolve an ambiguous external mutation within the same execution.

Choose `https://github.com/daski-io/provider-full` if any operation needs
dynamic quotes, durable jobs, retries after restart, multiple active replicas,
human review, email, admin, direct A2A, protected-data workflows, assets,
actions, later input, cancellation, or delayed ambiguity reconciliation. When
fit is uncertain, prefer the full starter. The repositories are alternatives,
not layers; never recreate full-starter subsystems inside the minimal core.

State the selection and the facts supporting it before implementation.

## Map the product before writing code

Read [Integration brief](references/integration-brief.md) and produce an
operation mapping that names the buyer-visible outcome, closed input and result
bounds, price behavior, one fixed API/MCP operation, authentication owner,
timeouts, side effects, idempotency, ambiguity reconciliation, data boundary,
readiness proof, and environment separation.

One Daski skill maps to one reviewed product operation. Never expose an
arbitrary buyer-selected URL, HTTP method, path, header, MCP server, transport,
tool name, schema, or credential. The upstream product is the supplier even
when the provider organization owns it.

## Implement within the selected boundary

For the minimal starter:

1. Copy `src/services/dummy` to `src/services/<service-slug>` and keep product
   configuration, client, validation, adapter, docs, and tests there.
2. Define stable ids, closed schemas, strict bounds, a fixed atomic-USDC price,
   terminal artifacts, and safe public error codes. Reject unknown fields and
   revalidate in the adapter.
3. Map each skill to one hard-coded operation. Use the repository's bounded
   outbound helpers, endpoint pinning, explicit time/size/concurrency limits,
   strict response parsing, and redacted errors. Honor `context.signal`.
4. Use a stable product idempotency key for mutations. Journal intent before a
   non-convergent call and reconcile authoritative product state after
   ambiguity. If that cannot finish synchronously, stop and use `provider-full`;
   never guess or blindly retry.
5. Register the service only in `src/providerServices.ts`. Paid skills derive
   from manifests. Coordinate contract or price changes with Daski and obtain a
   new runtime bundle; never add a second outcome allowlist.
6. Keep service tests in `src/services/<slug>/tests/` and use a fake product
   client. Unit tests must not call live systems.
7. Keep PostgreSQL for paid replay/idempotency, evidence, rate-limit, and
   terminal-result state. Remove dummy before Mainnet and keep core generic.

For `provider-full`, read [Full-provider workflow](references/provider-full.md)
before editing and then follow that repository's `AGENTS.md` and service guides.
Do not apply the minimal terminal-only contract to jobs, assets, or lifecycle
work, and do not copy the minimal runtime-bundle importer into the full starter.

## Diagnose and verify

Use scripts declared by the selected repository rather than recreating their
logic. Start with the offline dummy and read-only `doctor`, then run targeted
service tests and the documented typecheck, test-typecheck, lint, architecture,
documentation, unit, coverage, readiness, audit, and build gates appropriate to
the change. Run `skill:validate` in the minimal repository.

Database smoke or migration checks must target an explicitly identified
disposable database. Report stable doctor codes and missing variable names,
never configured values. A passing build or doctor proves technical checks,
not Daski admission or Mainnet approval.

## Preserve hard stops

- Never fabricate, edit, recompress, combine, resign, or weaken validation of
  Daski-issued policies, admissions, action catalogs, or runtime bundles. Never
  edit runtime-catalog rows by hand.
- Never expose secrets, wallet keys, signed envelopes, buyer/product protected
  data, supplier account details, raw product output, or private policy.
- Do not call a live product, mutate a shared database, register identity,
  install a bundle, sign an offer, fund a wallet, send a chain transaction,
  deploy, push, tag, release, retire a service, or change Mainnet without
  explicit authority for that exact action and environment.
- Testnet precedes Mainnet. Mainnet requires explicit Daski whitelisting through
  Discord and a coordinated release; no local flag, artifact, or test grants it.
- Never make readiness or admission permissive to unblock a fixture or deploy.
- When Daski-owned inputs are missing, finish safe local work, list every
  missing input, and stop at the external boundary.

## Complete the handoff

Read [Onboarding and handoff](references/onboarding-handoff.md) when the work
approaches Testnet, Mainnet, or another operator. Report the starter decision,
product-to-skill mapping, repository/revision, files changed, gates and doctor
codes, remaining provider/product/Daski inputs, authorizations still required,
and the next safe action. Separate local completion, Testnet admission, and
Mainnet approval.
