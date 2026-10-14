# Releasing

Releases are coordinated Daski events, not just Git tags. `develop` is the
integration branch. Do not push `main`, tag, or publish a GitHub release until
Testnet review and the intended environment approval are complete.

## Candidate checklist

1. Freeze the reviewed service/skill/schema/price/origin/wallet/outcome set.
2. Run every command in `README.md` from a clean clone.
3. Run the disposable PostgreSQL migration smoke check and production image
   boundary checks in CI.
4. Complete the end-to-end Testnet cases in `docs/onboarding.md`.
5. Scan for credentials, personal/protected data, raw product output, `.env`,
   provider-specific examples, and dummy code.
6. Record the commit and image digest and obtain Daski release approval.
7. For Mainnet, confirm the whitelist and all environment separation controls.

The tag version, `package.json` version, and agent-skill version must match.
The release workflow produces a source archive, a standalone agent-skill
archive, and checksums. Do not hand-build replacement archives from a dirty
working tree.

The initial stable release is `v1.0.0`; version `0.x` remains pre-release.
Changing a reviewed public contract after approval requires a new candidate and
usually a new Daski artifact set.

## Gateway wire fixtures

`test/fixtures/provider-wire/` is the gateway's canonical synthetic
provider-wire fixture set, vendored byte for byte (marked `-text` in
`.gitattributes`) with its source recorded in
`test/fixtures/provider-wire.source.json`: repository, 40-hex commit, path and
the sha256 of `manifest.json`. `test/providerWireParity.test.ts` checks
offline that the directory holds exactly the manifest and the files it lists
with their checksums; `test/providerWireVectors.test.ts` and
`test/providerWireNegatives.test.ts` drive the quote, intake, dispatch,
status and lifecycle handlers through every vector a lite provider answers
and compare status, media type and canonical body. Tests never download the
fixtures. Do not edit them; when the gateway publishes a new revision,
re-vendor from that commit and update the source record:

```bash
git -C ../gateway archive <commit> test/fixtures/provider-wire | tar -x
git -C ../gateway show <commit>:test/fixtures/provider-wire/manifest.json | sha256sum
```

Known intentional difference: the intake vector answers `supported: true`;
lite answers `supported: null` (availability not determined, as the gateway's
intake documentation defines it) and the test pins that exact re-signed body.

## Legacy-image barrier qualification

The first R1 upgrade must exclude the released pre-R1 image (baseline
`1d3fb23`). `test/legacyImageBarrierPostgres.test.ts` boots that actual
compiled image against databases this build migrated and runs only when
`LEGACY_PROVIDER_ROOT` names a built copy of it. Build the copy outside the
checkout and remove it afterwards:

```bash
git worktree add --detach /tmp/provider-pre-r1 1d3fb23
(cd /tmp/provider-pre-r1 && npm ci --ignore-scripts && npm run build)
LEGACY_PROVIDER_ROOT=/tmp/provider-pre-r1 DATABASE_URL_TEST=<disposable loopback URL> \
  npx vitest run test/legacyImageBarrierPostgres.test.ts
git worktree remove --force /tmp/provider-pre-r1
```

It proves the old image boots on its own database (the control), then that
after an R1 boot it cannot boot under a single owner, separate principals or a
superuser, fails its startup sweep even with no executing row, cannot change
rows from code that was already running, and that its privilege reset, run
outside its boot path or by an old boot under a superuser migration URL (a
layout both images refuse), changes only grants (and, for the superuser, the
schema owner), never a row, which R1 restores after the documented
remediation. Record the run with the release evidence.
