# Troubleshooting

Start with a redacted diagnostic report:

```bash
npm run doctor -- --stage=testnet
npm run doctor -- --stage=testnet --json
```

Doctor performs no mutations or network calls. Do not paste `.env` to support.

## Doctor codes

| Code | Meaning | Remedy |
| --- | --- | --- |
| `NODE_VERSION` | The active Node major is not 24. | Select Node 24, reinstall with `npm ci`, and retry. |
| `ENV_FILE` | `.env` is absent. | Copy `.env.example` to `.env`; never commit it. |
| `CONFIG_REQUIRED` | Required common variables are missing or obvious placeholders. | Use `docs/configuration.md` and fill only provider-owned values; obtain Daski-owned values through onboarding. |
| `STANDARD_RAIL_ARTIFACTS` | A Testnet/Mainnet rail binding is missing. | Install one complete reviewed Daski set; do not invent or mix values. |
| `RUNTIME_BUNDLE_REQUIRED` | Doctor deliberately does not inspect or mutate the runtime catalog. | Install each Daski-issued service bundle with `npm run daski:install-runtime -- --file <path>`. |
| `DEPENDENCIES_INSTALLED` | `node_modules` is absent. | Run `npm ci` with Node 24. |
| `MAINNET_RUNTIME` | Mainnet production, chain, database TLS/roles, proxy, or edge posture is incomplete. | Complete the Mainnet checklist in `docs/onboarding.md`. |
| `DUMMY_SERVICE_REMOVED` | The Testnet-only dummy is still present. | Replace and remove it before Mainnet. |
| `MAINNET_WHITELIST_REQUIRED` | Manual Daski approval cannot be checked locally. | Request whitelisting through Discord after Testnet completion. |

Warnings are not permissions. `MAINNET_WHITELIST_REQUIRED` remains a manual
release gate even when every machine check passes.

## Configuration fails before boot

The sanitized bootstrap prints one structured error without a stack trace.
Common causes:

- `PROVIDER_WALLET_PRIVATE_KEY` is not `0x` plus exactly 64 non-zero hex
  digits;
- `PROVIDER_AGENT_ID` is not an unsigned decimal integer;
- a required URL is not credential-free HTTPS;
- `CHAIN_ID` is not Base Sepolia `84532` or Base `8453`;
- `CHAIN_MODE=mock` is used outside loopback or in production/Mainnet;
- `DATABASE_SSL_MODE` is not `verify-full` in production;
- production migration/runtime database URLs are missing or identical;
- proxy/bypass CIDRs are too broad; or
- Mainnet identity/USDC addresses are not canonical.

Fix the named field. Do not catch `ConfigurationError`, add a fallback secret,
or relax validation.

## Global policy or runtime bundle is rejected

`STANDARD_RAIL_GLOBAL_POLICY_JSON` contains gateway-signed global rail
envelopes. The runtime-bundle file contains provider intent, gateway
preparation, exact skill contracts, activation evidence, and runtime
commitments for one service. Both are issued/reviewed as one coordinated set.

Do not decode/edit/resign either artifact to make it pass. Confirm that the
complete values belong to the same environment, chain, gateway origin/audience,
provider wallet/identity, service build, schema, price, and release. A changed
contract hash, mismatched signer, expired envelope, duplicate skill, or
splitter-provenance mismatch is a hard failure and requires a new bundle.

Run the importer only against the intended provider database:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

An identical bundle is an idempotent no-op. If boot warns that an installed
paid skill has no promoted runtime listing, the service is not purchasable yet;
install the reviewed bundle rather than weakening exact-set checks.

If boot logs `listing commitment drift`, this build's published skill contract
changed after the installed bundle was issued. The process stays online so
Daski can read the new AgentCard, but the gateway may quarantine the service.
Request, review, and install a replacement bundle before accepting purchases.

## PostgreSQL is unreachable

For the bundled local database:

```bash
npm run dev:db:up
docker compose ps
```

Check that `DATABASE_URL` uses `127.0.0.1:55432`, the Compose credentials, and
database `daski_provider`. On Windows/WSL with Docker Desktop, confirm WSL
integration is enabled. Do not expose port 55432 on all interfaces.

Production failures commonly come from an unavailable CA bundle, URL-encoded
password error, untrusted certificate name, blocked egress, or wrong role.
Keep `verify-full`; repair the certificate/hostname. The migration principal
must own/create schema objects; the runtime principal must not.

An applied migration checksum mismatch means a tracked migration was edited
after use. Restore it exactly and add a new numbered migration for the change.

## `/health/live` passes but `/health/ready` fails

Liveness only proves the process exists. Readiness fails closed when the
database, provider identity, or standard-rail chain/evidence posture is stale
or invalid. Check structured application logs by event/error class, then verify:

- PostgreSQL connectivity;
- chain/RPC network and reviewed code hashes;
- provider wallet/agent ownership binding;
- runtime-listing/evidence coordinates and finality;
- public origin/audience agreement; and
- product readiness if your service adds a dependency check.

Do not route paid traffic based on liveness.

## Dispatch is rejected

Public responses are deliberately generic. Correlate only safe request ids and
structured error classes. Frequent causes are wrong content type/encoding,
duplicate JSON keys, stale envelope, wrong audience/environment/chain/signer,
changed replay, quote/request hash mismatch, outcome/schema/price drift,
non-final or disagreeing evidence, sanctions lookup failure, self-purchase,
capacity, or service input rejection.

Do not log the signed envelope, request, evidence bundle, private key, or raw
product response to diagnose it. Reproduce with synthetic data in unit tests or
coordinate a redacted Testnet trace with Daski.

## Product call times out or is ambiguous

The adapter has a hard 50-second budget and should set a smaller product
timeout. A known definitive product rejection can map to a stable failed result.
A disconnect/timeout after a mutation may have landed is ambiguous.

Use the product's idempotency key and authoritative read to reconcile before
retrying. If that cannot be completed during the dispatch, this operation does
not fit the minimal starter; move it to `provider-full`. Never label an unknown
outcome successful or blindly repeat the mutation.

## Same order returns a different result or is rejected

An exact same signed dispatch returns the persisted state/result. A dispatch
with the same order id but a different dispatch hash is an attack or protocol
error and is rejected. Ensure the gateway retries the original bytes and does
not regenerate request, nonce, quote, or evidence fields.

After a provider restart, an interrupted `executing` row becomes terminal
`failed` with `provider_restarted_during_execution`. The minimal runtime must
have one active replica. If transparent resumption is required, use
`provider-full`.

## Agent or Windows tooling fails on line endings

The repository declares LF in `.gitattributes`, and the skill validator also
normalizes CRLF. If files were created before that rule, renormalize in a clean
branch with Git and review the diff. Do not change migration content merely to
fix line endings after it has been applied.

On Windows, run Node/npm in the checkout environment where dependencies were
installed. The tooling tests spawn Node directly and do not rely on `npm.cmd`
shell behavior.

## Safe support bundle

Share only:

- repository version/commit and image digest;
- operating system, Node major, and PostgreSQL major;
- doctor JSON with values remaining redacted;
- failing command/test name and sanitized stack location;
- public provider origin and public chain/contract coordinates; and
- non-sensitive correlation ids approved for support.

Never share `.env`, database URLs, wallet/API keys, signed envelopes, buyer
input, raw product output, database dumps, access-bearing URLs, or unrestricted
logs.
