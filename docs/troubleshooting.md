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

## Standard-rail artifact is malformed or differs from launch policy

`STANDARD_RAIL_OUTCOMES_JSON` is gzip-compressed base64 JSON, issued/reviewed
as one artifact. It must contain exactly the outcome ids in
`src/providerLaunchPolicy.ts`, with no duplicates or extras.

Do not decode/edit/recompress it. Confirm you copied the complete value without
whitespace truncation and that it belongs to the same environment, chain,
provider wallet/audience, service/skill, schema, price, and release. Request a
new consistent artifact when code changed.

If boot says an outcome references an unknown skill or its price differs from
the manifest, update the service contract through onboarding; do not make one
side silently accept the other.

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
- outcome/evidence coordinates and finality;
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
