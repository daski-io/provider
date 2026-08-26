---
name: daski-provider
description: Build or diagnose a minimal fixed-price synchronous Daski provider from an existing API or MCP product, choose between provider and provider-full, and prepare provider Testnet or Mainnet onboarding. Use for provider-side service integration and onboarding; do not use for Daski buyer clients or unrelated API/MCP gateways.
license: MIT
metadata:
  version: "0.1.0"
---

# Daski provider

Help a provider expose an existing product through Daski without weakening the
payment, replay, identity, network, or product boundary. Repository
documentation is authoritative; this skill routes work and preserves hard
stops. It is harness-agnostic and assumes no Claude-, Codex-, or IDE-specific
capability.

## Establish context

1. Locate the repository and read `AGENTS.md` completely before acting. Follow
   any closer repository instruction.
2. Inspect the working tree and preserve unrelated changes. Distinguish a
   request to review/diagnose from authorization to edit, deploy, sign, spend,
   migrate external state, release, or push.
3. Identify the intended stage. Default implementation to offline/local work
   followed by Testnet; never default to Mainnet.
4. Read only the authoritative guides needed:

   - setup: `docs/getting-started.md` and `docs/configuration.md`;
   - API/MCP mapping: `docs/integrating-existing-product.md`;
   - implementation: `docs/adding-a-service.md` and `SECURITY.md`;
   - admission: `docs/onboarding.md`;
   - diagnosis: `docs/troubleshooting.md`;
   - protocol changes: `docs/architecture.md` and
     `docs/protocol-cheatsheet.md`.

Do not substitute remembered Daski behavior for the checked-out contracts.

## Choose the starter before editing

Use this `provider` repository only when every operation is:

- fixed-price;
- fully automated;
- one-shot and terminal within 50 seconds;
- free of later buyer input, cancellation, or owner action;
- free of durable private asset/lifecycle management; and
- able to resolve an ambiguous external mutation within the same execution.

If any condition fails—or the product needs dynamic quotes, jobs, retries after
restart, multiple execution replicas, human review, email, admin, direct A2A,
protected-data workflows, assets, or actions—stop and recommend
`https://github.com/daski-io/provider-full`. Do not recreate full-starter
features inside the minimal core.

## Understand the existing product

Gather only adapter-relevant facts:

- buyer-visible outcome and exact input/output bounds;
- fixed atomic-USDC price;
- fixed API endpoint/method or MCP server/transport/tool;
- provider-held authentication and environment separation;
- product timeout, response-size, and concurrency bounds;
- mutation idempotency and immediate authoritative reconciliation;
- terminal artifact schema and safe error codes; and
- product readiness and Testnet side effects/costs.

Map product operations to focused Daski skills. Never expose an arbitrary URL,
HTTP method, path, header, MCP server, tool name, schema, or credential chosen
by the buyer. The upstream product is the supplier even when provider-owned.

## Implement an authorized integration

1. Copy `src/services/dummy` to `src/services/<service-slug>`; keep product
   configuration, client, validation, adapter, docs, and tests there.
2. Define stable service/skill ids, strict request bounds, a fixed price, and
   terminal artifact/error schemas. Reject unknown fields.
3. Map each skill to one hard-coded reviewed API/MCP operation. Use bounded
   outbound helpers, endpoint pinning, explicit time/size/concurrency limits,
   strict response parsing, and redacted errors. Never call raw `fetch` from a
   service or construct a shell command from buyer input.
4. Revalidate in the adapter, honor `context.signal`, and return only
   `completed` or `failed` before the execution budget expires.
5. Use a stable product idempotency key for mutations. Journal intent before a
   non-convergent call and reconcile authoritative product state after
   ambiguity. If reconciliation cannot finish synchronously, stop and use
   `provider-full`; never guess or blindly retry.
6. Register the service only in `src/providerServices.ts`. Keep the exact
   reviewed outcome set in `src/providerLaunchPolicy.ts`; coordinate schema,
   id, price, capacity, deadline, payee, or origin changes with Daski.
7. Keep service tests in `src/services/<slug>/tests/`; use a fake product
   client and never call live systems from unit tests.
8. Remove dummy before Mainnet. Keep core product-neutral.

PostgreSQL is required for paid runtime replay/idempotency, evidence,
rate-limit, and terminal-result state. Do not replace it with process memory.
The offline `npm run try-skill -- dummy echo` path is intentionally database-
and network-free.

## Diagnose and verify

Use repository commands rather than recreating their logic:

- offline: `npm run try-skill -- dummy echo "hello"`;
- local: `npm run doctor`;
- Testnet: `npm run doctor -- --stage=testnet`;
- Mainnet machine checks: `npm run doctor -- --stage=mainnet`;
- automation: add `--json`.

Run targeted service tests, then the documented typecheck, test typecheck,
lint, architecture, docs, skill, unit, coverage, Mainnet-readiness, audit, and
build gates appropriate to the change. Database smoke checks must target only
an explicit disposable database.

Report stable doctor codes and missing variable names, never secret values. A
passing build/doctor proves technical checks only, not Daski admission.

## Hard stops

- Never fabricate, edit, recompress, combine, resign, or weaken validation of
  Daski-issued bindings.
- Never expose secrets, wallet keys, signed envelopes, buyer/product protected
  data, supplier account details, raw product output, or private policy in code,
  docs, logs, prompts, or chat.
- Do not call a live product, run a migration against shared data, register an
  identity, sign an offer, fund a wallet, send a chain transaction, deploy,
  push, tag, release, or change Mainnet without explicit authority for that
  action and environment.
- Testnet precedes Mainnet. Mainnet requires explicit Daski whitelisting through
  Discord and a coordinated release; no repository flag, artifact, or test can
  grant it.
- Never make readiness/admission permissive to unblock a fixture or deployment.
- When Daski-owned inputs are missing, complete safe local work, list each
  missing input, and stop at the handoff.

## Handoff

State the starter decision, product-to-skill mapping, files changed, gates run,
doctor stage/codes, remaining provider/product/Daski inputs, and next safe
action. Clearly separate local completion, Testnet admission, and Mainnet
approval.
