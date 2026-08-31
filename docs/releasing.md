# Releasing

Releases are coordinated Daski events, not just Git tags. `develop` is the
integration branch. Do not push `main`, tag, or publish a GitHub release until
Testnet review and the intended environment approval are complete.

## Agent Skill release semantics

The canonical package under `.agents/skills/daski-provider/` is both a tracked
repository skill and a separately installable release artifact. Its version in
`SKILL.md`, the package version, and the `v`-prefixed Git tag must match.

This revision is prepared for a possible authorized `v0.1.0` GitHub
**pre-release**. No public tag or release exists yet, and this preparation does
not authorize creating one. The release workflow marks every `0.x` version as
a GitHub pre-release; the documented initial stable release remains `v1.0.0`.
If Daski elects to wait for `v1.0.0`, leave `v0.1.0` unpublished.

After an authorized release exists, document both distribution channels:

- **Latest:** `npx skills add daski-io/provider --skill daski-provider` follows
  the repository's current default branch. It is convenient but mutable.
- **Pinned:** use the tagged skill URL
  `https://github.com/daski-io/provider/tree/v0.1.0/.agents/skills/daski-provider`
  or `gh skill install daski-io/provider daski-provider --allow-hidden-dirs
  --pin v0.1.0`. A full commit SHA may replace the tag when the installation
  must be fixed to one commit.

Do not describe a default-branch command as immutable or stable. Changing the
GitHub default branch is a separate repository-setting decision and is not
part of a source release.

## Release assets

For an authorized tag, the workflow produces:

- `provider-<version>.tar.gz`, the full source archive;
- `daski-provider-agent-skill.zip`, the standalone skill under one
  `daski-provider/` root; and
- `SHA256SUMS`, covering both archives.

Before publication, CI compares the ZIP entry list with the exact canonical
entrypoint and five reference files. This excludes provider runtime code,
credentials, `.env`, generated output, and unrelated documentation. CI then
verifies `SHA256SUMS`; do not hand-build replacement archives from a dirty
working tree.

For `v0.1.0`, the future asset locations are:

```text
https://github.com/daski-io/provider/releases/download/v0.1.0/daski-provider-agent-skill.zip
https://github.com/daski-io/provider/releases/download/v0.1.0/SHA256SUMS
```

These URLs are not available until the authorized tag and pre-release are
published.

## Candidate checklist

1. Freeze the reviewed service/skill/schema/price/origin/wallet/outcome set.
2. Confirm the tag, `package.json`, and Agent Skill metadata versions match.
3. Run every command in `README.md` from a clean clone.
4. Run the disposable PostgreSQL migration smoke check and production image
   boundary checks in CI.
5. Complete the end-to-end Testnet cases in `docs/onboarding.md`.
6. Build the release assets, inspect the standalone skill ZIP, and verify
   `SHA256SUMS` before publication.
7. Scan for credentials, personal/protected data, raw product output, `.env`,
   provider-specific examples, dummy code, and generated archives.
8. Record the commit and image digest and obtain Daski release approval.
9. For Mainnet, confirm the whitelist and all environment separation controls.

Changing a reviewed public contract after approval requires a new candidate
and usually a new Daski artifact set.
