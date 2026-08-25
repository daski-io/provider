# Daski provider Agent Skill

The repository includes a portable Agent Skill for humans who want a coding
agent to adapt an existing API or MCP product, diagnose setup, or prepare Daski
onboarding.

Canonical source:

```text
.agents/skills/daski-provider/SKILL.md
```

The skill follows the open
[Agent Skills specification](https://agentskills.io/specification). It uses
only portable frontmatter and instructions—no Claude-only command injection,
Codex-only tool dependency, bundled executable, or duplicated protocol manual.

## What the skill does

The skill tells an agent how to:

- detect whether the task is setup, product mapping, implementation,
  diagnosis, onboarding, or release preparation;
- read the right checked-in guide instead of relying on remembered Daski
  behavior;
- map fixed API endpoints or MCP tools to a typed `ServiceModule` and skills;
- preserve payment, ownership, supplier-journal, protected-data, and readiness
  boundaries;
- run the repository's doctor and quality gates;
- report exactly which Daski/supplier inputs are still missing; and
- stop before unauthorized chain, deployment, database, supplier, Mainnet, or
  release actions.

The skill is not another copy of this documentation. `README.md`, `AGENTS.md`,
`docs/`, and `SECURITY.md` remain authoritative and versioned with the code.

## Use it without installing anything

Any coding agent with repository access can be prompted directly:

```text
Read AGENTS.md and .agents/skills/daski-provider/SKILL.md completely. Then map
my existing product API to a Daski service and tell me which facts are missing
before implementation.
```

This is the most universal path and works even when a harness does not support
automatic skill discovery.

## Codex and OpenAI clients

Codex automatically discovers repository skills under `.agents/skills`, so a
Codex session opened in this repository or its subdirectories can select
`$daski-provider` implicitly or explicitly.

For a personal installation usable across provider forks, copy the
`daski-provider` directory to:

```text
$HOME/.agents/skills/daski-provider/
```

Alternatively, ask Codex's `$skill-installer` to install the skill directory
from this repository or from the versioned release package. Restart only if a
new skill does not appear automatically.

Current official behavior is documented in
[OpenAI's Build skills guide](https://learn.chatgpt.com/docs/build-skills).

## Claude Code

Claude Code uses the same open `SKILL.md` format. Copy or symlink the canonical
directory to one of Claude's discovery locations:

```text
.claude/skills/daski-provider/       project installation
$HOME/.claude/skills/daski-provider/ personal installation
```

Keep `.agents/skills/daski-provider/SKILL.md` as the only maintained source in
your provider fork. If you copy rather than symlink it, repeat the copy when
updating the repository so the installed skill does not drift.

See [Claude Code's skill documentation](https://code.claude.com/docs/en/slash-commands)
for current discovery and invocation behavior.

## Other Agent Skills clients

Install the `daski-provider` directory in the client location that supports
the open Agent Skills standard, or attach `SKILL.md` as task instructions. The
skill assumes only:

- filesystem access to a Daski provider checkout;
- ability to read repository guidance;
- shell access for the documented npm commands; and
- normal user approval before external mutations.

If a client ignores skills, the direct prompt shown above remains valid.

## Validate the checked-in skill

```bash
npm run skill:validate
```

The repository gate checks the portable frontmatter, name, scope description,
version, required documentation routing, size, unfinished markers, and
non-portable syntax. The full documentation gate also verifies that commands
and local links referenced by the skill still exist.

The maintainer validation should additionally run the `skill-creator` quick
validator when that tool is available and exercise realistic trigger and
non-trigger prompts. A schema validator cannot prove that an agent makes good
decisions.

## Suggested prompts

Product mapping before code:

```text
Use $daski-provider. Our product already exposes these REST endpoints and jobs.
Map them to one or more Daski services and skills, identify unsafe pass-through
ideas, and produce the smallest implementation plan. Do not edit yet.
```

API-backed implementation:

```text
Use $daski-provider to implement the reviewed service mapping. Keep the product
client in the service, pin its origin, validate request and response schemas,
journal mutations, add co-located tests, and stop before Testnet registration
or deployment.
```

MCP-backed implementation:

```text
Use $daski-provider. Adapt only the allowlisted MCP tools in this product
contract; do not expose a buyer-selected server or tool. Add job reconciliation,
readiness, docs, and service tests.
```

Testnet preparation:

```text
Use $daski-provider to audit this fork for Testnet onboarding. Run the read-only
doctor and local gates, prepare the review packet, and list Daski-issued inputs
that are still missing. Do not fabricate artifacts or run chain writes.
```

These prompts add task-specific intent; the skill supplies the reusable
workflow and safety boundary.

## Distribution and releases

The canonical skill is versioned with the provider starter. A tagged provider
release packages only the skill directory as a separate archive so it can be
installed without copying the whole repository. Pin the skill package to the
same release as the provider fork whenever possible.

Do not publish a floating skill that describes a newer protocol than the
provider code it is modifying. When upstream provider behavior changes, update
the repository docs and skill routing together, validate them, and issue a new
versioned release.

## Permissions and Mainnet

Invoking the skill does not grant permission to:

- register a provider or write to a chain;
- migrate a shared database;
- call a live supplier mutation;
- deploy a provider;
- merge or push a release branch;
- publish a package/release; or
- request or claim Mainnet admission.

Mainnet still requires successful Testnet work, explicit Daski whitelisting
requested through the [Daski Discord](https://discord.gg/uyeMp7Q2HW), and the
coordinated release review. The skill must stop at that boundary.
