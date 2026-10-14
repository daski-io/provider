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

`permission denied for table ...` under separate principals means the runtime
role is missing a reviewed grant. Boot reapplies the allowlist in
`src/core/db/runtimePrivileges.ts` through `MIGRATION_DATABASE_URL`; confirm
that variable names the schema owner, then restart. Never grant the runtime
role ownership, `DELETE`, or DDL to work around it.

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

## Quote is refused or unavailable

The gateway reports `PROVIDER_QUOTE_REJECTED` for a provider 4xx and
`PROVIDER_QUOTE_UNAVAILABLE` for a 5xx or an unusable answer. Check the
provider log's `reason`:

- `envelope`/`signature`: environment, chain, provider audience
  (`STANDARD_RAIL_PROVIDER_AUDIENCE`), `STANDARD_RAIL_GATEWAY_SIGNER`, or a
  clock more than 30 seconds off;
- `outcome_policy`: the gateway quoted a listing version that is not the
  installed runtime-catalog head; install the matching bundle;
- `request_invalid`: the request fails the published schema or the service's
  readiness hook; the field errors reach the buyer;
- `capacity`: the listing version's nonterminal tasks reached
  `maxOpenOrders`; new sales resume as they finish; and
- `service_unavailable`: provider readiness, the readiness hook, or the
  database failed; fix the dependency rather than the check.

A quote clock check failing at the gateway usually means the provider clock
drifted; keep NTP healthy.

## Dispatch is rejected

A dispatch answered with JSON `{"error":"dispatch_rejected","reason":...}` was
definitely not admitted; the gateway retries with a new envelope. The reason
is a reviewed code:

- `signature`/`envelope_lifetime`/`validator`: signer, audience, environment,
  chain, clock, an envelope that expired before its claim could commit, or a
  malformed request;
- `outcome_policy`/`self_purchase`: the listing version is not the installed
  catalog head, or the payer is a provider wallet;
- `quote_window`/`price`: the forwarded `QuoteV1` or the persisted provider
  quote it names does not bind this order (unknown or zero quote hash,
  different request, payer or window), or the amount differs;
- `evidence`: chain evidence, settlement timing (judged by the deposit block
  timestamp), sanctions, or evidence already admitted for another order; and
- `service_unavailable`: provider readiness or the database failed before
  anything was admitted.

Listing capacity, paused sales, and quote age never refuse a funded dispatch.
An empty-body `503` is deliberate ambiguity: admission exists, may exist, or
could not be checked, so the gateway reconciles through status instead of
sending a new envelope. A JSON `429 rate_limit_exceeded` on dispatch or
status means the source exhausted its unauthenticated-failure bucket; find
the misconfigured or hostile caller, or exempt the reviewed gateway egress
with `RATE_LIMIT_BYPASS_IPS`.

Do not log the signed envelope, request, evidence bundle, private key, or raw
product response to diagnose it. Reproduce with synthetic data in unit tests or
coordinate a redacted Testnet trace with Daski.

## Status answers 404 `outcome_policy`

`404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}` means a
fresh, signature-verified status query found no claim at all for that order.
The gateway acts on it only after the original envelope's `validBefore` plus
60 seconds, and the database refuses any claim that would commit at or after
`validBefore`, so the answer cannot be overtaken by a slow request. A bad
signature, stale query, different existing claim (`409 binding_conflict`),
database failure, or signing failure is never this answer.

## Lifecycle read is refused or unavailable

| Answer | Cause and fix |
| --- | --- |
| `409 artifact_unavailable` | The task is not `completed`; read `status`. Failed tasks never have an artifact. |
| `409 unsupported_action` | `input`, `cancel` and `support` are not implemented by this starter; nothing happened. Use `provider-full` for them. |
| `503 lifecycle_unavailable` | Database, signing or contract-account RPC failure, a busy or rate-limited servicing call, or a stored result that no longer matches its frozen hash (logged as `terminal_identity_unverifiable`). Retry; a payer-signed retry needs a fresh authorization. |
| `401 lifecycle_rejected` / `grant` or `signature` | The grant is not a current `ProviderLifecycleGrantV1` for this provider audience signed by `STANDARD_RAIL_GATEWAY_SIGNER` as `gateway-lifecycle`. Check the environment, chain, audiences and signer. |
| `403 lifecycle_rejected` / `binding` or `authorization` | The grant does not bind this call, a read capability was used for another action or scope, or the payer signature is invalid for the order's payer (contract accounts need `PAYER_ACCOUNT_TYPES=eoa,contract`). |
| `404 lifecycle_rejected` / `unknown_task` | No claim for the order and task under this gateway audience. |

## Product call times out or is ambiguous

The adapter has a hard 50-second budget and should set a smaller product
timeout. A known definitive product rejection can map to a stable failed result.
A disconnect/timeout after a mutation may have landed is ambiguous.

Use the product's idempotency key and authoritative read to reconcile before
retrying. If that cannot be completed during the dispatch, this operation does
not fit the minimal starter; move it to `provider-full`. Never label an unknown
outcome successful or blindly repeat the mutation.

## Same order returns a different result or is rejected

An exact same signed dispatch returns the persisted state and attestation,
re-signed with a fresh observation, even after its envelope expired. A
different envelope for an order that already has a claim is never admitted:
it gets the ambiguous `503`, and status for its hash answers `409
binding_conflict`. The original claim stays authoritative; reconcile with the
original dispatch hash.

After a provider restart, an interrupted `executing` row becomes terminal
`failed` with `provider_restarted_during_execution`. The minimal runtime must
have one active replica. If transparent resumption is required, use
`provider-full`.

A completed task's attested identity (state, result hash and completion time)
is frozen when it becomes terminal and never changes. PostgreSQL refuses an
update that would alter it (`a terminal task identity is frozen`) or a claim's
bindings (`an admitted claim keeps its bindings`); fix the caller instead of
editing the row.

## A synchronous task failed with `service_result_invalid`

The adapter returned a completed result that core could not freeze: it failed
the listing version's admitted `resultSchema`, the response JSON budget, the
1 MB bound or the artifact rules (`https` credential-free URLs, lowercase
names). The log line `Synchronous result failed its admitted result contract`
names the task and a stable `diagnostic` (`result_schema_mismatch`,
`result_out_of_bounds`, `result_active_content`, `result_unstorable` or
`result_artifact_invalid`)
with schema keywords, never the result. `result_active_content` means a
string broke the gateway's passive-output rule (markup tags such as `<form>`,
`javascript:` URLs, `on…=` attributes or control characters), which the gateway
would refuse to relay; decline such input before payment with a
`requestReadiness` hook, as the dummy does. Fix the adapter mapping or, if the
published schema is wrong, change it and request a newly issued bundle. A
failure whose code is not in the module's `failureCodes` is attested as
`service_execution_failed`.

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
