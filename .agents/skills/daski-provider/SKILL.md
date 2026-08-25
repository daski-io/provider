---
name: daski-provider
description: Adapt an existing API or MCP product into a Daski provider starter or fork, diagnose provider setup, and prepare supplier Testnet or Mainnet onboarding. Use for provider-side ServiceModule, skill, readiness, and onboarding work; do not use for Daski buyer integrations or unrelated marketplace applications.
license: MIT
metadata:
  version: "1.0.0"
---

# Daski provider

Help a supplier expose an existing product through the Daski provider without
weakening the provider's protocol, payment, ownership, or operational
boundaries. Repository documentation is authoritative; this skill routes the
work and preserves the non-obvious stopping rules.

## Establish context

1. Locate the provider repository and read its `AGENTS.md` completely before
   acting. Follow a closer repository instruction if one exists.
2. Inspect the working tree and preserve unrelated changes. Determine whether
   the request is explanation, diagnosis, implementation, onboarding, or
   release preparation; do not infer mutation authority from a read-only task.
3. Determine the intended stage: offline dummy, local, Testnet, or Mainnet.
   Default implementation and onboarding work to Testnet.
4. Read only the repository guides needed for the task:

   - setup or first boot: `docs/getting-started.md` and
     `docs/configuration.md`;
   - existing API or MCP product: `docs/integrating-existing-product.md`;
   - service implementation: `docs/adding-a-service.md`, then
     `docs/daski-skill-creation-best-practices.md` and `SECURITY.md`;
   - Daski admission: `docs/onboarding.md`;
   - errors: `docs/troubleshooting.md`;
   - architecture or protocol changes: `docs/architecture.md` and
     `docs/protocol-cheatsheet.md`.

Do not substitute remembered Daski behavior for the checked-out repository's
contracts.

## Understand the existing product

Gather only facts that affect the adapter. Ask for missing facts when they
would materially change the implementation:

- buyer-visible operations and inputs/outputs;
- API endpoints or MCP tools, authentication, and fixed upstream origins;
- synchronous versus job-based completion, polling, webhooks, and cancellation;
- external mutations, idempotency, ambiguous outcomes, and reconciliation;
- pricing inputs and any supplier-spend ceiling;
- provisioned assets, lifecycle, ownership, and consequential actions;
- protected or human-party data, retention, and redaction;
- supplier sandbox/live separation and operational readiness signals.

Produce a mapping from product operations to one Daski service and focused
skills before writing code. Never expose an arbitrary API endpoint, MCP server
URL, method, or tool name selected by the buyer. Map an explicit allowlist to
typed service operations.

## Implement within the provider boundary

When the user authorizes implementation:

1. Start from `src/services/dummy` and keep all product behavior, configuration,
   clients, workers, docs, migrations, and tests in
   `src/services/<service-slug>/`.
2. Validate buyer input before quoting and again before executing. Return exact
   atomic-USDC prices or structured field errors.
3. Use reviewed outbound-network helpers, fixed supplier origins, bounded
   requests/responses, strict schemas, and stable public error codes. Do not
   call supplier-controlled destinations directly.
4. Journal non-convergent external mutations before dispatch. Reconcile
   authoritative supplier state after timeouts or ambiguous responses; never
   guess or blindly retry.
5. Derive ownership from the wallet-authorized payer. Use the standard action
   catalog and delayed second authorization for destructive actions; do not
   create service-local authorization.
6. Declare workers, live supplier invariants, protected-data sinks, asset
   identifiers, and readiness through the existing `ServiceModule` facets only
   when the product needs them.
7. Register the service only in `src/providerServices.ts`. Keep reviewed paid
   outcome and action ids exact in `src/providerLaunchPolicy.ts` and coordinate
   changes with Daski onboarding.
8. Keep service-owned tests under `src/services/<service-slug>/tests/`. Update
   manifest, docs, validation, code, migrations, and adversarial tests together.
9. Remove the dummy before Mainnet and keep the core free of product-specific
   or supplier-specific exceptions.

## Diagnose and verify

Use the repository's commands rather than recreating their logic:

- offline learning: `npm run try-skill -- dummy echo`;
- local checks: `npm run doctor`;
- Testnet checks: `npm run doctor -- --stage=testnet`;
- Mainnet machine checks: `npm run doctor -- --stage=mainnet`;
- automation output: add `--json`;
- opt-in read-only public/RPC probes: add `--live`.

Run targeted service tests first, then the documented typecheck, lint,
architecture, unit, coverage, readiness, documentation, skill, audit, build,
and disposable-database gates appropriate to the change. Never point smoke,
migration, or security scripts at a shared Testnet or production database.

Report stable doctor codes and missing variable names, not secret values. A
successful build or doctor run proves technical checks only; it does not prove
Daski admission.

## Hard stops and authority

- Never fabricate, edit, resign, or weaken validation of Daski-issued signed
  outcome, servicing-admission, or asset-action artifacts.
- Never expose secrets, protected inputs, supplier account data, private policy,
  or raw runtime output in code, docs, logs, prompts, or chat.
- Do not run provider registration, chain writes, deployments, supplier
  mutations, database migrations, or releases without authorization for that
  exact environment and action.
- Testnet is mandatory before Mainnet. Mainnet is not self-service: stop until
  the supplier has explicit Daski whitelisting requested through the Daski
  Discord and the coordinated release review is complete. No local flag,
  signed artifact, test result, or code change grants whitelisting.
- Do not make readiness permissive to unblock a fixture or deployment.
- If required Daski coordinates or artifacts are missing, finish all safe local
  work, list the exact missing inputs, and stop at that external boundary.

## Handoff

State the product-to-service mapping, files changed, checks run, doctor stage
and codes, missing Daski or supplier inputs, and the next safe action. Clearly
separate locally complete work from Testnet admission and Mainnet approval.
