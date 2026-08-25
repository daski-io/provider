# Releasing the provider starter

This is the maintainer checklist for an upstream provider-starter release. It
does not authorize a provider fork's Testnet registration, deployment, or
Mainnet admission.

## Release boundary

Development lands on `develop`. A release may move the exact reviewed commit
to `main` and tag it only after:

- the generic implementation and documentation are frozen;
- a clean human install walkthrough succeeds;
- the Agent Skill is validated and exercised;
- the complete CI/security/database/container gates pass;
- a hosting-neutral Testnet candidate completes the applicable end-to-end
  journey;
- no provider-specific fixture, credential, policy, or runtime output remains;
  and
- the repository owner gives explicit final release approval.

Do not use a near-equivalent rebuild, squash with unreviewed content, or moving
tag. The branch, image, skill package, and release notes must identify one
commit.

## Candidate checks

From a clean clone of the intended `develop` commit, use Node 24 and run:

```bash
npm ci --ignore-scripts
npm run security:audit
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run skill:validate
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run build
```

Run the PostgreSQL migration, concurrency, and security checks only against the
explicit disposable release databases described by CI. Build the production
image and verify its non-root user and excluded test/docs/scripts boundaries.

Also validate:

```bash
docker compose config --quiet
npm run doctor
```

The local doctor may warn about missing Daski artifacts in a clean public
clone. The deployed Testnet candidate must pass:

```bash
npm run doctor -- --stage=testnet --live
```

## Testnet evidence

Exercise the items applicable to the candidate's real service contract:

- discovery and public docs;
- open free request;
- invalid and valid quote;
- paid dispatch and durable status;
- terminal artifacts/evidence/reputation;
- asset ownership and owner actions;
- delayed destructive confirmation;
- cancellation around irreversible boundaries;
- restart/recovery of durable work;
- ambiguous external mutation reconciliation; and
- dependency/worker readiness failure and recovery.

The upstream generic starter must not retain a private provider service merely
to create this evidence. Use isolated candidate fixtures or the separately
reviewed Testnet provider, then remove all credentials, captures, and runtime
output from the working tree.

## Version and changelog

For the first stable release:

1. set the root package version to `1.0.0` without changing dependencies;
2. move the completed changelog items from `Unreleased` to `1.0.0` with the
   release date;
3. keep the Agent Skill metadata version at `1.0.0`;
4. rerun every candidate check; and
5. record the exact commit hash approved for release.

Later releases keep package, tag, changelog, and skill metadata versions
aligned when the skill behavior changes.

## Main and tag

After explicit final approval, update `main` to the exact approved commit using
the repository's reviewed branch process. Do not push an intermediate commit
to `main`. Verify remote `main` matches the approved hash, then create and push
the annotated `v1.0.0` tag without an AI attribution or co-author trailer.

The tag-triggered release job reruns the full verification job, checks that the
tag matches both `package.json` and the Agent Skill metadata, archives
`.agents/skills/daski-provider/` as a
standalone ZIP, writes its SHA-256 checksum, and creates the GitHub release.

Never delete or retarget a published stable tag. If a release is wrong, fix it
on `develop` and publish a new version.

## Repository publication

After the stable release exists:

- make `main` the default branch;
- confirm branch protection and required release checks;
- set repository description, topics, homepage, security-advisory support, and
  MIT license metadata;
- publish release notes that distinguish provider code from the optional skill
  package; and
- update Daski public provider pages to link the repository, onboarding guide,
  Discord, and versioned skill package.

Public-page updates happen after the repository release so they can pin a
stable source rather than `develop`.

## Release evidence hygiene

Release notes and assets may contain public commit hashes, checksums, versions,
contract coordinates, and redacted test summaries. They must not contain:

- private keys or signed buyer authorizations;
- admin, API, webhook, database, or encryption secrets;
- customer/protected payloads;
- supplier account data or raw responses;
- private provider policy;
- database dumps, environment files, or raw runtime logs; or
- private Testnet transaction/support identifiers not approved for publication.
