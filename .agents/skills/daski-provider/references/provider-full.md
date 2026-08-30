# Full-provider workflow

Read this reference only after `provider-full` is selected or when evaluating a
product that may require its capabilities. Then read the checked-out
`provider-full/AGENTS.md` and current documentation; they are authoritative.

Repository: `https://github.com/daski-io/provider-full`

## Why the full starter exists

Use it for any dynamic quote, durable job, later buyer input, cancellation,
asset lifecycle, owner action, human review, email, admin operation, direct A2A
flow, protected-data workflow, multi-replica execution, or ambiguity that must
reconcile after restart. These are durability and authorization requirements,
not optional conveniences to copy into the minimal starter.

## Map product behavior to service facets

Keep product-specific code in `src/services/<slug>/` and add only the facets
the product needs:

- manifest, skill contracts, quote validation, adapter, docs, and tests;
- product configuration and bounded clients;
- service migrations and idempotent seed data;
- durable workers, jobs, and live readiness invariants;
- supplier-operation journals and reconciliation;
- asset identifiers, lifecycle, ownership lookup, and standard actions;
- protected-data sinks, redaction, and encrypted identifiers;
- bounded service routes, inbound email, or agent tools;
- screening requirements and provider-policy scopes; and
- audited admin extensions.

Register the module only in `src/providerServices.ts`. Core must remain product
neutral and must not import services; sibling services must not import each
other.

## Implementation sequence

1. Define stable service/skill ids, closed input and result schemas, capacity,
   deadlines, pricing behavior, fulfillment mode, and any asset/action
   contracts. Coordinate taxonomy and buyer-visible semantics with Daski.
2. Validate buyer input before quoting and again before execution. Quote exact
   atomic-USDC amounts or structured field errors. Bound supplier-derived
   pricing and external-spend ceilings.
3. Implement explicit product operations behind reviewed network/MCP
   boundaries. Honor cancellation and never return raw supplier data.
4. Journal non-convergent supplier intent before mutation. Use stable logical
   keys, bounded retries, circuit breaking, and authoritative reconciliation.
   Never infer success from a timeout or blindly repeat a purchase.
5. Persist jobs and lifecycle changes with database locks, leases,
   idempotency, and fencing. Do not add process-local money, task, worker, or
   ownership guards.
6. Derive ownership from the verified payer. Use admitted standard actions for
   consequential asset mutations. Destructive actions require the delayed
   second authorization and mismatch/replay tests; never invent a service-local
   signature scheme.
7. Add append-only checksummed service migrations only for service-owned state.
   Declare workers, readiness, protected-data sinks, and admin behavior through
   existing service contracts.
8. Keep service tests under `src/services/<slug>/tests/`; update manifest,
   schema, docs, code, migrations, readiness, and adversarial tests together.
9. Remove dummy before Mainnet and scan for provider-specific or secret data.

## Registration boundary

The full starter owns reviewed self-registration through its
`daski:register` package script. Invoke it only from the checked-out full
repository and pass its required
`--gateway https://<reviewed-testnet-gateway>` argument.

That command can obtain gateway preparations, sign provider intent, persist and
broadcast chain writes, activate services, and promote runtime catalog state.
Retirement is a separate externally mutating operation. Do not run either
merely because implementation or local verification was requested. Require
explicit authority for the exact environment, gateway, wallet, service set,
transaction cost, and action; verify configuration and the intended service set
before execution.

Do not copy the minimal starter's Daski-assisted runtime-bundle importer into
`provider-full`, and do not hand-edit its catalog or registration state.

## Full-starter documentation route

After checkout, use:

- `docs/getting-started.md` for milestones and local setup;
- `docs/integrating-existing-product.md` for product mapping;
- `docs/adding-a-service.md` for the `ServiceModule` contract;
- `docs/daski-skill-creation-best-practices.md` for buyer-agent contracts;
- `docs/configuration.md` and `SECURITY.md` for environment/trust boundaries;
- `docs/onboarding.md` for registration and admission; and
- `docs/troubleshooting.md` for stable diagnostics.

Run scripts from the checked-out `package.json`; do not assume the minimal and
full starters expose identical commands or configuration.
