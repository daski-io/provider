# Daski provider agent skill

The repository ships one portable, harness-agnostic skill package:

```text
.agents/skills/daski-provider/SKILL.md
```

Its entrypoint helps a coding agent choose the correct starter, inspect an
existing API or MCP product, implement a service, run gates, and prepare the
Testnet handoff. Focused references make the released package useful before a
repository is cloned. After checkout, `README.md`, `AGENTS.md`, and `docs/`
remain authoritative; the skill deliberately does not duplicate their full
manuals.

## Package contents

```text
.agents/skills/daski-provider/
  SKILL.md
  references/
    start-here.md
    integration-brief.md
    provider-full.md
    onboarding-handoff.md
```

`SKILL.md` contains shared routing, the minimal-versus-full boundary, authority
rules, and hard stops. An agent reads a reference only when that phase or
starter applies:

- `start-here.md` selects and acquires a repository;
- `integration-brief.md` produces a safe product-to-skill mapping;
- `provider-full.md` restores the full starter's durability, ownership, and
  registration workflow; and
- `onboarding-handoff.md` separates local, Testnet, Mainnet, and operator
  responsibilities.

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
whether the product actually fits the minimal starter.

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
2. Read repository instructions and the routed docs.
3. Apply the minimal-versus-full fit test and switch before implementation if
   the wrong starter was selected.
4. Produce the packaged integration brief covering exact product operation,
   input/output, auth, environment, idempotency, ambiguity, and data boundaries.
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

The validator normalizes LF/CRLF, checks required frontmatter, reference routes,
and package contents, keeps the entrypoint concise, and requires its version to
match `package.json`. Release CI archives the entire skill directory so
partners receive the references without copying the provider runtime.

When the repository evolves, update authoritative docs first and change the
skill only when its routing, decision boundary, or hard stops change.
