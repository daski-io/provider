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
