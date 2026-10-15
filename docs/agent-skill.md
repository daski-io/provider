# Daski provider agent skill

The repository ships one portable, harness-agnostic skill package:

```text
.agents/skills/daski-provider/SKILL.md
```

Its entrypoint helps a coding agent choose the correct path (lite
synchronous, lite external job, or `provider-full`), inspect an existing API,
MCP, or job-running product, implement a service, run gates, and prepare the
Testnet handoff. Focused references make the released package useful before a
repository is cloned. After checkout, `README.md`, `AGENTS.md`, and `docs/`
remain authoritative; the skill deliberately does not duplicate their full
manuals.

## Install or refresh it

```bash
npx skills add https://github.com/daski-io/provider --skill daski-provider
```

This is the command the Daski providers page publishes; harness-specific
variants add an agent flag such as `-a claude-code` or `-a codex`. An
installed skill is a copy and does not change when this repository changes:
re-run the command to refresh an older installation. The skill's
`metadata.version` equals this repository's `package.json` version (the
validator enforces it), so an agent can tell a stale skill or an older
checkout apart: version 0.2.0 introduced external-job mode, which a 0.1.x
checkout does not have. The skill instructs agents to check the checkout's
actual capabilities before proposing an API, and to name a compatible
release rather than invent one.

## Package contents

```text
.agents/skills/daski-provider/
  SKILL.md
  references/
    daski-primer.md
    start-here.md
    integration-brief.md
    external-jobs.md
    provider-full.md
    onboarding-handoff.md
```

`SKILL.md` contains shared routing, the capability check, the three-path
selection rule, authority rules, and hard stops. An agent reads a reference
only when that phase or path applies:

- `daski-primer.md` gives a zero-context agent the marketplace, transaction,
  call-time versus fulfillment-time, trust-boundary, and vocabulary model;
- `start-here.md` checks the checkout's capabilities, selects the path, and
  acquires a repository;
- `integration-brief.md` produces a safe product-to-skill mapping, including
  payment mapping, idempotency, job, deadline, and retention facts;
- `external-jobs.md` walks through the synthetic external-job example, the
  typed call outcomes, the idempotency horizon, pending and overdue polling,
  result mapping, and the restart and upgrade tests;
- `provider-full.md` explains when the full starter is necessary, its
  worker and registrar workflow, and the feature groups not yet available;
  and
- `onboarding-handoff.md` separates local, Testnet, Mainnet, upgrade, and
  operator responsibilities.

## Use it with any coding agent

Agent products differ in how they discover local skills. Use the supported
mechanism documented by your current Claude, Codex, or other harness to add the
entire directory above—not only `SKILL.md`—or explicitly tell the agent to read
its entrypoint before modifying the repository.

When installed before checkout, the skill can select and acquire the correct
starter, collect a safe integration brief, and explain the next boundary. Once
the repository exists, it switches to that revision's tracked documentation.
Do not copy the skill's text into a prompt and let that copy drift. The package
has no scripts, credentials, network authority, or provider-specific
configuration of its own.

This skill is canonical only in
[provider](https://github.com/daski-io/provider). The
[provider-full](https://github.com/daski-io/provider-full) repository links to
it but does not publish a duplicate package. The first decision in the skill is
which path the product's facts support; duration alone never decides it.

## Recommended agent prompt

Provide a concise description or documentation for the existing product and
say:

```text
Use the installed daski-provider skill. If no provider checkout exists, select
the correct starter before acquiring it. After checkout, read AGENTS.md and the
repository guides routed by the skill. Map only this reviewed API/MCP
operation: <operation>. Do not call a live product, deploy, sign, register,
spend funds, or change a Daski-issued artifact. Implement with fake-client
tests and stop at the Testnet onboarding handoff.
```

Attach only safe API/MCP schemas or sandbox documentation. Never place product
tokens, wallet keys, `.env`, customer data, signed artifacts, or raw production
responses in an agent prompt.

## Expected agent workflow

1. If necessary, select and acquire the correct repository using the packaged
   start reference.
2. Read repository instructions and the routed docs, and check that the
   checkout has the capability the path needs.
3. Apply the three-path fit test and switch before implementation if the
   wrong starter or mode was selected.
4. Produce the packaged integration brief covering exact product operation,
   input/output, auth, payment mapping, environment, idempotency, ambiguity,
   job, deadline, retention, and data boundaries.
5. Implement the service in its own folder with a fixed operation map.
6. Update composition, published contract, environment names, docs, and tests.
7. Run local gates without contacting live systems.
8. Produce a redacted review packet and list the Daski-owned Testnet policy and
   runtime-bundle inputs still required.
9. Stop before any external mutation, signing, deployment, registration,
   funding, Mainnet change, or push unless a human explicitly authorizes it.

## Validate the skill

```bash
npm run skill:validate
npm run docs:check
```

The validator normalizes LF/CRLF, checks required frontmatter, reference
routes, and package contents, keeps the entrypoint concise (at most 180
lines), and requires its version to match `package.json`. It also requires the
three-path table and the published install command, refuses the retired
routing phrasings that contradict the three paths and code-like references to
adapter members, outcomes or outbound HTTP helpers the checked-out source does
not declare (the same heuristic rules `docs:check` applies to the repository
guides), refuses references to the evaluation briefs an installed copy does
not include, and allows links only to Daski's two public starter repositories,
its site and its Discord invite. Release CI archives the entire skill
directory so partners receive the references without copying the provider
runtime.

When the repository evolves, update authoritative docs first and change the
skill only when its routing, decision boundary, or hard stops change.

## Evaluate the skill

[Twelve synthetic product briefs](../test/fixtures/skill-evaluations/README.md)
(S-T01 to S-T12) state the path the skill should select and the plan,
adapter outline and stopping behavior expected for each: a two-second API,
an eight-hour audit with a recoverable start, the same audit behind a public
x402 endpoint only, an unrecoverable start, full-only capabilities, an older
checkout, a bearer job URL, a generic-proxy request, a deployment while jobs
are pending, an expired idempotency horizon with an invalid report, and the
published package itself. Run them against the packaged skill in a clean
agent session after any routing change and record the selected path, plan and
outline, not only keyword matches.
