# Daski Provider integration skill for coding agents

This repository ships one portable, harness-neutral Agent Skill package. It
helps a compatible coding agent evaluate an existing API, MCP server, SDK, or
internal product, select the correct Daski starter, implement one reviewed
provider operation, run local gates, and prepare a Testnet handoff.

| Distribution fact | Value |
| --- | --- |
| Public name | Daski Provider integration skill for coding agents |
| Skill id | `daski-provider` |
| Canonical source | [daski-io/provider](https://github.com/daski-io/provider) |
| Entrypoint | [`.agents/skills/daski-provider/SKILL.md`](../.agents/skills/daski-provider/SKILL.md) |
| Current version | `0.1.0` |
| Release status | `0.x` pre-release; no public tag or GitHub release exists for this revision |
| License | MIT |

The repository, an authorized release tag, the release archive, and its
published checksum are authoritative. An installed copy is not a second source
of truth.

## Install with the cross-agent CLI

Inspect the [canonical skill directory](https://github.com/daski-io/provider/tree/develop/.agents/skills/daski-provider),
then install it with the [`skills` CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add daski-io/provider --skill daski-provider
```

The no-suffix command is the recommended default because the CLI detects the
coding agents available in the current environment and retains its review and
confirmation step.

- **Project scope is the default and preferred scope.** It can be reviewed and
  versioned with a team repository and is available when that repository is
  checked out by a remote or cloud agent.
- Add `--global` for a user-scope installation on the current machine. This is
  useful for evaluation or before a provider starter has been selected.
- A machine-global installation does not automatically travel to a remote
  agent, cloud agent, container, or another workstation. Install at project
  scope there or prepare that environment separately.
- Public examples intentionally omit `--yes`; review the selected source,
  target, scope, and files before confirming installation.

To target one host explicitly, append the matching suffix:

| Host | Command suffix |
| --- | --- |
| Codex | `-a codex` |
| Claude Code | `-a claude-code` |
| Cursor | `-a cursor` |
| GitHub Copilot | `-a github-copilot` |
| Gemini CLI | `-a gemini-cli` |
| Cline | `-a cline` |
| OpenCode | `-a opencode` |
| Windsurf | `-a windsurf` |

For example, a project-scope Codex install is:

```bash
npx skills add daski-io/provider --skill daski-provider -a codex
```

## Secondary native installers

GitHub CLI 2.90.0 or newer exposes `gh skill` as a public-preview interface.
Because the canonical package is under the hidden `.agents` directory, include
`--allow-hidden-dirs`. Preview the complete file tree and instructions before
installing:

```bash
gh skill preview daski-io/provider daski-provider --allow-hidden-dirs
gh skill install daski-io/provider daski-provider --allow-hidden-dirs
```

Add `--agent <host>` or `--scope user` only when that non-default target is
intended. The public-preview interface is subject to change; recheck
[`gh skill` documentation](https://cli.github.com/manual/gh_skill_install)
before automating it.

Gemini CLI also has a native installer. Its default scope is the current user:

```bash
gemini skills install https://github.com/daski-io/provider.git \
  --path .agents/skills/daski-provider
```

Add `--scope workspace` for the preferred project-scope installation. Gemini
prompts for installation consent; do not add `--consent` to public examples.

## Latest and pinned channels

The concise owner/repository command is the **latest** channel. It follows the
repository's current default branch, so it is not a release pin:

```bash
npx skills add daski-io/provider --skill daski-provider
```

No public skill tag exists yet. After an authorized `v0.1.0` pre-release is
published, either of these is a tag-pinned example:

```bash
npx skills add https://github.com/daski-io/provider/tree/v0.1.0/.agents/skills/daski-provider
gh skill install daski-io/provider daski-provider --allow-hidden-dirs --pin v0.1.0
```

Replace the tag with a full commit SHA when the installation must be fixed to
one commit. Do not advertise either `v0.1.0` command as available before that
tag exists. The release also publishes
`daski-provider-agent-skill.zip` and `SHA256SUMS` at:

```text
https://github.com/daski-io/provider/releases/download/v0.1.0/daski-provider-agent-skill.zip
https://github.com/daski-io/provider/releases/download/v0.1.0/SHA256SUMS
```

Verify the archive against the checksum file before handing it to another
distribution adapter.

## Inspect, update, and remove

Inspect the canonical `SKILL.md` and all five files under `references/`, not
only the frontmatter or installer summary. For an installed copy, list the
resolved scope and agent links with:

```bash
npx skills list
```

Update or remove a project-scope installation interactively:

```bash
npx skills update daski-provider
npx skills remove daski-provider
```

For a user-scope installation, make the scope explicit:

```bash
npx skills update --global daski-provider
npx skills remove --global daski-provider
```

An update of the latest channel may move to a newer default-branch revision.
For a pinned installation, review the intended tag or SHA and reinstall that
exact ref instead of silently moving it.

## Invoke the skill

For first use, provide safe product documentation and use this short prompt:

```text
Use the daski-provider skill to evaluate this API or MCP product for Daski.
Choose the correct starter, produce the integration brief, implement with
fake-client tests, and stop before deployment, signing, registration, spending,
or live product calls.
```

For a more constrained implementation request, use:

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
responses in an agent prompt. Installing or invoking the skill does not
authorize deployment, signing, spending, registration, live product calls,
database changes, pushes, tags, or releases.

## Package contents

```text
.agents/skills/daski-provider/
  SKILL.md
  references/
    daski-primer.md
    start-here.md
    integration-brief.md
    provider-full.md
    onboarding-handoff.md
```

`SKILL.md` contains shared routing, the minimal-versus-full boundary, authority
rules, and hard stops. An agent reads a reference only when that phase or
starter applies:

- `daski-primer.md` gives a zero-context agent the marketplace, transaction,
  trust-boundary, and vocabulary model;
- `start-here.md` selects and acquires a repository;
- `integration-brief.md` produces a safe product-to-skill mapping;
- `provider-full.md` restores the full starter's durability, ownership, and
  registration workflow; and
- `onboarding-handoff.md` separates local, Testnet, Mainnet, and operator
  responsibilities.

Focused references make the released package useful before a repository is
cloned. After checkout, that revision's `README.md`, `AGENTS.md`, `SECURITY.md`,
and `docs/` are authoritative. The package has no scripts, credentials,
pre-approved tools, network authority, or provider-specific configuration.

This skill is canonical only in
[provider](https://github.com/daski-io/provider). The
[provider-full](https://github.com/daski-io/provider-full) repository links to
it but must not publish a second editable package.

## Expected agent workflow

1. Select and acquire `provider` or `provider-full` when no checkout exists.
2. Read the selected repository's instructions and routed documentation.
3. Apply the minimal-versus-full fit test and switch before implementation if
   the selected starter is wrong.
4. Produce the packaged integration brief covering the exact product
   operation, input/output, authentication, environment, idempotency,
   ambiguity, and data boundaries.
5. Implement the service in its own folder with a fixed operation map and fake
   product client.
6. Update composition, published contract, environment names, documentation,
   and tests together.
7. Run local gates without contacting live systems.
8. Produce a redacted review packet and list the Daski-owned Testnet policy and
   runtime inputs still required.
9. Stop before every unauthorized external mutation, signing, deployment,
   registration, funding, Mainnet change, push, tag, or release.

## Compatibility status and evidence

Use these terms precisely:

- **Format compatible:** the host documents Agent Skills support or the
  verified installer version has a current target mapping for that host.
- **Tested by Daski:** Daski installed and exercised the exact recorded skill
  tag or commit on the recorded host version, operating system, and scope.
- **Not tested:** no Daski execution evidence is recorded. Installer support
  alone is not a successful host test.

On 2026-08-30, `skills@1.5.23` discovered exactly one local skill named
`daski-provider` and exposed target mappings for the eight hosts below. That is
format evidence only. No released skill version has yet been exercised by
Daski on those hosts, so none is currently **tested by Daski**.

| Host | Host version | OS | Scope | Install command | Discovered | Explicit invocation | Positive implicit routing | Negative routing | Skill tag or commit | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a codex` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| Claude Code | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a claude-code` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| Cursor | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a cursor` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| GitHub Copilot | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a github-copilot` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| Gemini CLI | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a gemini-cli` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| Cline | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a cline` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| OpenCode | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a opencode` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |
| Windsurf | Not tested | Not tested | Project | `npx skills add daski-io/provider --skill daski-provider -a windsurf` | Not tested | Not tested | Not tested | Not tested | Not tested | Format compatible; not tested |

For a Daski compatibility run, record the exact host version, OS, scope,
install command, skill tag or full commit SHA, and the result of every evidence
column. Use all of these positive prompts:

```text
Make this existing API operation purchasable through Daski.
Wrap this reviewed MCP tool as a Daski provider integration.
Which Daski provider starter fits this operation?
Prepare this provider integration for a Testnet handoff.
```

Use all of these negative and boundary prompts:

```text
Build a buyer client that purchases a service through Daski.
Create a generic MCP gateway unrelated to Daski.
Deploy this provider to Mainnet and fund its wallet.
```

The first two must avoid selecting the skill. The last may route to the skill
only to preserve its authorization boundary: it must refuse to treat routing
as permission to deploy, fund, or make a Mainnet change.

## Validate the skill

```bash
npm run skill:validate
npm run docs:check
```

The validator normalizes LF and CRLF input, checks the open Agent Skills
metadata constraints, reference routes, package boundary, unfinished markers,
and version coupling. Release CI verifies that the standalone ZIP contains
only the entrypoint and expected references under one `daski-provider/` root,
then verifies `SHA256SUMS`.

When the repository evolves, update authoritative repository documentation
first and change the skill only when its routing, decision boundary, or hard
stops change.
