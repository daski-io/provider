# Start here: select and acquire a provider starter

Read this reference when there is no checkout yet, the user has not chosen a
starter, or the current repository may not fit the product.

## Establish the starting point

Determine which of these applies:

1. **Existing provider fork:** work in the supplied repository. Inspect its
   remotes, branch, status, `AGENTS.md`, package metadata, and documentation.
   Do not replace it with a fresh clone or discard local work without explicit
   direction.
2. **Starter checkout:** verify whether it is `provider` or `provider-full` and
   apply the fit test in `SKILL.md` before editing.
3. **No checkout:** select a starter from product facts, state the decision,
   then obtain it in the user's intended workspace as a normal local setup step.
   If the destination or whether to fork versus clone materially affects their
   workflow, ask before creating it.

Do not combine the two starters or copy one repository's core into the other.

## Acquire the selected starter

Minimal fixed-price synchronous provider:

```bash
git clone https://github.com/daski-io/provider.git
cd provider
npm ci
npm run try-skill -- dummy echo "hello daski"
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
PostgreSQL 16 or newer. The offline dummy and unit tests require no database,
wallet, RPC, gateway, payment, or external product. Use the committed lockfile;
do not mix first installation with an unrequested dependency update.

## Read the checked-out authority

After checkout:

1. Read `AGENTS.md` completely.
2. Inspect `README.md`, `package.json`, `.env.example`, and the working tree.
3. Route to the repository's current guides:

   - setup: `docs/getting-started.md` and `docs/configuration.md`;
   - product mapping: `docs/integrating-existing-product.md`;
   - implementation: `docs/adding-a-service.md` and `SECURITY.md`;
   - admission: `docs/onboarding.md`;
   - diagnosis: `docs/troubleshooting.md`;
   - protocol work: `docs/architecture.md` and
     `docs/protocol-cheatsheet.md`.

The checked-out files outrank this portable summary. If a routed file is
missing, inspect the repository's documentation index rather than inventing a
replacement contract.

## Inputs worth requesting

Ask only for information that changes the implementation:

- safe API, MCP, SDK, or internal-product documentation;
- buyer-visible operations and intended outcomes;
- fixed versus dynamic price behavior;
- synchronous, job, lifecycle, cancellation, and human-review behavior;
- authentication ownership and sandbox/live separation;
- mutation idempotency and authoritative reconciliation;
- data classification and retention expectations; and
- the intended stage and deployment constraints.

Do not ask the user to paste credentials, private keys, `.env`, signed Daski
artifacts, customer records, or raw production responses. Request variable
names, redacted schemas, and sandbox-safe examples instead.

## First checkpoint

Before code changes, report:

- selected repository and why;
- any operation that fails the minimal fit test;
- safe product information still missing;
- local prerequisites or repository issues; and
- the next authorized, reversible step.
