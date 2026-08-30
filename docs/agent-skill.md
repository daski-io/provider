# Daski provider agent skill

The repository ships one portable, harness-agnostic workflow entrypoint:

```text
.agents/skills/daski-provider/SKILL.md
```

It helps a coding agent choose the correct starter, inspect an existing API or
MCP product, implement a minimal service, run gates, and prepare the Testnet
handoff. It deliberately does not duplicate the manuals. `README.md`,
`AGENTS.md`, and `docs/` remain authoritative.

## Use it with any coding agent

Agent products differ in how they discover local skills. Use the supported
mechanism documented by your current Claude, Codex, or other harness to add or
reference the directory above, or explicitly tell the agent to read its
`SKILL.md` before modifying the repository.

Do not copy the skill's text into a prompt and let that copy drift. Keep the
repository directory intact so its relative documentation routes continue to
work. The skill has no scripts, network access, secrets, or provider-specific
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
Read AGENTS.md and .agents/skills/daski-provider/SKILL.md. Determine whether
this operation fits the minimal provider before editing. Map only the following
reviewed API/MCP operation: <operation>. Do not call a live product, deploy,
sign, register, spend funds, or change a Daski-issued artifact. Implement with
fake-client tests and stop at the Testnet onboarding handoff.
```

Attach only safe API/MCP schemas or sandbox documentation. Never place product
tokens, wallet keys, `.env`, customer data, signed artifacts, or raw production
responses in an agent prompt.

## Expected agent workflow

1. Read repository instructions and the routed docs.
2. Apply the minimal-versus-full fit test and stop if the wrong starter was
   selected.
3. Inventory exact product operation, input/output, auth, environment,
   idempotency, ambiguity, and data boundaries.
4. Implement the service in its own folder with a fixed operation map.
5. Update composition, published contract, environment names, docs, and tests.
6. Run local gates without contacting live systems.
7. Produce a redacted review packet and list the Daski-owned Testnet policy and
   runtime-bundle inputs still required.
8. Stop before any external mutation, signing, deployment, registration,
   funding, Mainnet change, or push unless a human explicitly authorizes it.

## Validate the skill

```bash
npm run skill:validate
npm run docs:check
```

The validator normalizes LF/CRLF, checks required frontmatter and documentation
routes, keeps the skill thin, and requires its version to match `package.json`.
Release CI packages the skill separately so partners can install it without
copying the runtime.

When the repository evolves, update authoritative docs first and change the
skill only when its routing, decision boundary, or hard stops change.
