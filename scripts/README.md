# Scripts

Read a script before running it. The minimal starter intentionally contains no
self-registration, chain deployment, database-reset, supplier-production, or
Mainnet automation.

## Safe local commands

- `npm run try-skill -- dummy echo "message"` invokes only the dummy adapter
  in memory. It performs no payment, database, network, chain, or product call.
- `npm run doctor -- --stage=<local|testnet|mainnet>` performs redacted,
  read-only local checks. Add `--json` for stable machine-readable output. It
  does not validate external reachability or whitelist status.
- `npm run dev:db:up` starts loopback-only PostgreSQL 16 for development.
  `npm run dev:db:stop` stops it and preserves the named volume.
- `npm run copy-assets` copies service documentation to `dist`; `npm run build`
  invokes it automatically.

## Reviewed runtime-bundle import

`npm run daski:install-runtime -- --file <path>` is a controlled database
mutation, not a learning command. It validates a Daski-issued bundle against
the configured signers, policy, provider wallet, and exact local service
contract before applying migrations and atomically promoting append-only
runtime catalog versions. It does not call the gateway/product or send a chain
transaction. Run it only with explicit authorization for the intended bundle
and database; keep the artifact out of Git and support channels.

## Verification internals

- `scripts/docs-check.mjs` verifies local Markdown links and documented npm
  commands.
- `scripts/validate-skill.mjs` validates portable skill frontmatter, version,
  size, CRLF handling, and routes.
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
