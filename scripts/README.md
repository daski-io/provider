# Scripts

Read a script before running it. The minimal starter intentionally contains no
self-registration, chain deployment, database-reset, supplier-production, or
Mainnet automation.

## Safe local commands

- `npm run try-skill -- dummy echo "message"` invokes only the dummy adapter
  in memory. It performs no payment, database, network, chain, or product call.
- `npm run try-skill -- synthetic-audit audit "description"` tours one
  external job of the Testnet-only synthetic audit offline, with a fake clock
  and its in-memory product: a lost start answer, recovery by the order key,
  eight fake hours of pending polls, and the report judged against the
  published result contract. No payment, database, network or chain is used;
  the durable scheduler itself is covered by the PostgreSQL suites.
- `npm run doctor -- --stage=<local|testnet|mainnet>` performs redacted,
  read-only local checks. Add `--json` for stable machine-readable output. It
  does not validate external reachability or whitelist status. It is offline
  unless `--database` is given: then `src/doctorDatabase.ts` (run through tsx
  in a child process) reads PostgreSQL with `DATABASE_URL` in one `READ ONLY`
  snapshot that is rolled back, and never migrates, imports, activates or
  writes. Offline, database checks are reported as not performed (`skip`),
  and `scripts/doctor-summary.mjs` never summarizes such a run as ready.
- `npm run dev:db:up` starts loopback-only PostgreSQL 16 for development.
  `npm run dev:db:stop` stops it and preserves the named volume.
- `npm run copy-assets` copies service documentation to `dist`; `npm run build`
  invokes it automatically.

## Reviewed runtime-bundle import

`npm run daski:install-runtime -- --file <path>` is a controlled database
mutation, not a learning command. It validates a Daski-issued bundle against
the configured signers, policy, provider wallet, and exact local service
contract before applying migrations and atomically promoting append-only
runtime catalog versions as the migration principal; the runtime principal can
only read that catalog. It does not call the gateway/product or send a chain
transaction. Run it only with explicit authorization for the intended bundle
and database; keep the artifact out of Git and support channels.

## Upgrade and admission operator commands

`npm run daski:cutover` is the operator step of the first pre-R1 to R1
upgrade (`docs/onboarding.md`). It applies this build's migrations, which
install the legacy-process barrier, and prints the stop-and-drain inventory as
JSON; with `-- --resolve-legacy --old-processes-stopped` it also fails the
interrupted pre-R1 executions. Run it only after every pre-R1 process is
stopped.

`npm run daski:async-admission` reports the async-admission switch and its
prerequisites read-only; `-- --activate` and `-- --deactivate` change it
(`docs/configuration.md`). It never migrates. Neither command calls the
gateway, the product or the chain.

## Verification internals

- `scripts/docs-check.mjs` verifies local Markdown links, documented npm
  commands, and the consistency rules below in the repository's guides.
- `scripts/validate-skill.mjs` validates portable skill frontmatter, version,
  size, CRLF handling, routes, the three-path table, the install command, the
  consistency rules, that the package links only Daski's public repositories
  and channels, and that it never points at the evaluation briefs (or a
  "second fixture") an installed copy does not include.
- `scripts/skill-rules.mjs` holds the shared consistency rules, a heuristic
  list of the retired routing phrasings rather than a parser: a 50-second
  limit not scoped to the synchronous mode, duration or asynchrony as the
  reason for `provider-full`, defaulting to full when unsure, sending an
  ambiguity that outlives a call straight to full, denials that the lite
  starter runs product jobs, and claims of capabilities lite lacks or of
  paid-failure recovery. Negations count only within the same clause.
  Code-like member references on the task context, adapter and service
  module, invented lifecycle hooks, outcome kinds, bases, adapter modes and
  call-issue codes must match what `src/core/serviceRegistry/adapterTypes.ts`
  and `serviceModule.ts` declare, and names shaped like the reviewed outbound
  HTTP helpers (`boundedFetch`, `pinnedHttpRequest`, `reviewedEndpoint`)
  must be exports of `src/core/security/`. Vendored fixtures, buyer-facing
  service docs and `dist/` copies are not checked.
- `scripts/security/static-gates.mjs` enforces the minimal architecture,
  dependency, migration, entrypoint, and container boundary.
- `scripts/security/pii-scan.mjs` scans built artifacts for likely protected
  data and forbidden captured-output paths.
- `scripts/security/migration-smoke.mjs`, when present in release CI, must use
  only an explicit disposable `DATABASE_URL_TEST`. It may create/drop test
  schema state and must never receive a shared or production URL.

The Docker and GitHub workflow are repository interfaces; platform-specific
deployment descriptors belong in provider forks. No upstream script grants
Mainnet access.
