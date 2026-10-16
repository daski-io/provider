---
title: "Start here: select a path and acquire a starter"
status: canonical
authority: current repository implementation and approved maintainer workflow
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16 (documentation placement; no live release verification)
supersedes: repository-wide agent files as the home of general repository guidance
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/provider
review-trigger: setup, architecture, interface or workflow change
---

# Start here: select a path and acquire a starter

Read this reference when there is no checkout yet, the user has not chosen a
starter or mode, the checkout may be an older revision, or the current
repository may not fit the product.

## Establish the starting point

Determine which of these applies:

1. **Existing provider fork:** work in the supplied repository. Inspect its
   remotes, branch, status, `README.md`, package metadata, and documentation.
   Do not replace it with a fresh clone or discard local work without explicit
   direction.
2. **Starter checkout:** verify whether it is `provider` or `provider-full`,
   check its capabilities (below), and apply the path table before editing.
3. **No checkout:** select a path from product facts, state the decision,
   then obtain the starter in the user's intended workspace as a normal local
   setup step. If the destination or whether to fork versus clone materially
   affects their workflow, ask before creating it.

Do not combine the two starters or copy one repository's core into the other.

## Select the path

| Path | Required fit | Starter |
| --- | --- | --- |
| Lite synchronous | Fixed price, automated terminal result within the 50-second synchronous budget, no later buyer/asset/operator workflow, and no unresolved mutation ambiguity left for later. | `provider`, synchronous adapter (`execute`) |
| Lite external job | Fixed price; the product already owns the long-running execution; prompt submission, lookup, and poll calls; a durable job reference; safe start recovery; and a report that fits supported result delivery. No later buyer input, cancellation, assets, or operator workflow. | `provider`, external-job adapter (`start`, `recoverStart`, `poll`) |
| Full | Dynamic pricing, provider-owned multi-step workflows, later input or cancellation, assets/actions, human/operator review, richer protected data, email/admin/direct A2A, or intentional multi-replica operation. | `provider-full` |

Rules that decide the hard cases:

- Duration alone does not select full. An eight-hour audit whose start can be
  recovered and whose report can be polled is a lite external job.
- The presence of x402 alone does not prove integration compatibility.
  Daski's managed payment is the purchase; the product must let that verified
  order start an already-paid job. Never plan to pay its public endpoint
  again.
- If a lost start response cannot be reconciled (no lookup by order key and
  no documented same-key replay window), describe the upstream gap. Full is
  not a substitute for knowing whether a paid operation already happened.
- Recovery after a provider-terminal paid failure is a deferred full feature
  group, not a capability to promise. Late completion of still-nonterminal
  work is supported in both starters.
- A product that needs one full capability for any operation goes to full;
  the repositories are alternatives, not layers.

When a deciding fact is unknown, find it in the product's safe documentation
or ask for it; do not default to full because the job is long, and do not
default to lite because the call is fast.

## Check the checkout's capabilities and revision

Before proposing an API, confirm the checked-out revision has it:

- `provider` external-job mode: `src/core/serviceRegistry/adapterTypes.ts`
  declares `ExternalJobAdapter`, `src/core/externalJobs/` exists, and
  `src/services/synthetic-audit/` shows the pattern (package version 0.2.0 or
  later). An older checkout has only the synchronous `FulfillmentAdapter`.
- Compare this skill's `metadata.version` with the checkout's
  `package.json` version. A mismatch means one of them is stale: refresh the
  skill, or name the starter release the plan needs.
- The checkout records the `daski-io/gateway` commit it was qualified
  against in `test/fixtures/provider-wire.source.json` (`docs/releasing.md`
  explains that record and the companion gateway changes); record that
  commit.

If the selected path needs a capability the checkout lacks, select a
compatible released revision or report the upgrade requirement. Never invent
asynchronous methods, adapter members, or core edits in an older starter.

## Acquire the selected starter

Minimal fixed-price provider (synchronous or external job):

```bash
git clone https://github.com/daski-io/provider.git
cd provider
npm ci
npm run try-skill -- dummy echo "hello daski"
npm run try-skill -- synthetic-audit audit
```

Full provider:

```bash
git clone https://github.com/daski-io/provider-full.git
cd provider-full
npm ci
npm run try-skill -- dummy echo
npm run try-skill -- dummy create-note
```

Prefer a published stable release when one exists; otherwise use the
repository's current default branch unless the user specifies another ref.
Never silently switch an existing fork to a different branch or rewrite its
history.

Both starters require Git, Node.js 24, and npm. A running provider requires
PostgreSQL 16 or newer. The offline examples and unit tests require no
database, wallet, RPC, gateway, payment, or external product. Use the committed
lockfile; do not mix first installation with an unrequested dependency update.

## Install or refresh this skill

```bash
npx skills add https://github.com/daski-io/provider --skill daski-provider
```

Harness-specific variants add an agent flag, such as `-a claude-code` or
`-a codex`. An installed skill is a copy: it does not change when the
repository changes. Re-run the command to refresh an older installation, then
confirm its `metadata.version`.

## Read the checked-out authority

After checkout:

1. Read `README.md` completely.
2. Inspect `package.json`, `.env.example`, and the working tree.
3. Route to the repository's current guides:

   - setup: `docs/getting-started.md` and `docs/configuration.md`;
   - product mapping: `docs/integrating-existing-product.md`;
   - implementation: `docs/adding-a-service.md` and `SECURITY.md`;
   - admission and upgrades: `docs/onboarding.md` and `docs/releasing.md`;
   - diagnosis: `docs/troubleshooting.md`;
   - protocol work: `docs/architecture.md` and
     `docs/protocol-cheatsheet.md`.

The checked-out files outrank this portable summary. If a routed file is
missing, inspect the repository's documentation index rather than inventing a
replacement contract.

## Inputs worth requesting

Ask only for information that changes the path or the implementation:

- safe API, MCP, SDK, or internal-product documentation;
- buyer-visible operations and intended outcomes;
- fixed versus dynamic price behavior;
- synchronous, job, lifecycle, cancellation, and human-review behavior;
- how a verified Daski order starts already-paid product work;
- start idempotency, its retention window, and authoritative lookup;
- authentication ownership and sandbox/live separation;
- data classification and retention expectations; and
- the intended stage and deployment constraints.

Do not ask the user to paste credentials, private keys, `.env`, signed Daski
artifacts, customer records, or raw production responses. Request variable
names, redacted schemas, and sandbox-safe examples instead.

## First checkpoint

Before code changes, report:

- the selected path and the product facts supporting it;
- the checkout's revision and whether it has the needed capability;
- any operation that fails its path's fit, or an upstream gap;
- safe product information still missing;
- local prerequisites or repository issues; and
- the next authorized, reversible step.
