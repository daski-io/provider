# Troubleshooting

Start with a redacted diagnostic report:

```bash
npm run doctor -- --stage=testnet
npm run doctor -- --stage=testnet --json
npm run doctor -- --stage=testnet --database --json
```

Doctor performs no mutations and calls no product, chain or gateway. By
default it is offline and reports `DATABASE_DIAGNOSTICS` as `skip`: database
checks were not performed, which is never a pass. With `--database` it also
connects to PostgreSQL with `DATABASE_URL` (its only network use) and runs
this build's checks in one `READ ONLY` snapshot that is rolled back; it never
migrates, imports a bundle, activates async admission or writes a row, and it
reports counts and opaque references (task and instance ids), never inputs,
job references, URLs or key values.
The JSON report (`schemaVersion: 2`) carries `database`: `not_performed`,
`performed` or `unavailable`, and each check's status is `pass`, `warn`,
`fail` or `skip`. The database checks judge the database against the
configuration the doctor runs with, so run them with the deployment's
environment. Inside the production image, which ships no `scripts/`, `node
dist/doctorDatabase.js` prints the same database report. Do not paste `.env`
to support.

## Doctor codes

| Code | Meaning | Remedy |
| --- | --- | --- |
| `NODE_VERSION` | The active Node major is not 24. | Select Node 24, reinstall with `npm ci`, and retry. |
| `ENV_FILE` | `.env` is absent. | Copy `.env.example` to `.env`; never commit it. |
| `CONFIG_REQUIRED` | Required common variables are missing or obvious placeholders. | Use `docs/configuration.md` and fill only provider-owned values; obtain Daski-owned values through onboarding. |
| `STANDARD_RAIL_ARTIFACTS` | A Testnet/Mainnet rail binding is missing. | Install one complete reviewed Daski set; do not invent or mix values. |
| `RUNTIME_BUNDLE_REQUIRED` | Doctor never installs a bundle; only `--database` reads the catalog (`RUNTIME_CATALOG`). | Install each Daski-issued service bundle with `npm run daski:install-runtime -- --file <path>`. |
| `DEPENDENCIES_INSTALLED` | `node_modules` is absent. | Run `npm ci` with Node 24. |
| `MAINNET_RUNTIME` | Mainnet production, chain, database TLS/roles, proxy, or edge posture is incomplete. | Complete the Mainnet checklist in `docs/onboarding.md`. |
| `DUMMY_SERVICE_REMOVED` | The Testnet-only dummy is still present. | Replace and remove it before Mainnet. |
| `SYNTHETIC_EXAMPLE_NOT_COMPOSED` | `src/providerServices.ts` composes the Testnet-only synthetic audit. | Compose your own external-job service; the example has a fake product and refuses Base Mainnet. |
| `MAINNET_WHITELIST_REQUIRED` | Manual Daski approval cannot be checked locally. | Request whitelisting through Discord after Testnet completion. |
| `DATABASE_DIAGNOSTICS` | `skip`: offline run, database checks not performed. `pass`: the read-only snapshot ran. `fail`: they could not run (invalid configuration, named by variable only; unreachable database, named by its error code). | Add `--database`; fix the configuration or `DATABASE_URL` reachability, credentials and TLS. |
| `DATABASE_SCHEMA_EPOCH` | The database's schema epoch is not this build's (0 is the pre-R1 schema), or the legacy-process barrier is incomplete. | Follow the cutover in `docs/onboarding.md`, or run a build that supports the epoch; restore a damaged barrier from migration 005. |
| `DATABASE_MIGRATIONS` | Migrations are pending (`warn`; boot or the cutover applies them), the ledger names one this build does not ship or a changed checksum (`fail`), or the role cannot read the ledger (`skip`; the runtime principal never can). | Roll forward; never edit an applied migration. Run as the schema owner to compare checksums. |
| `ASYNC_ADMISSION` | The switch is off while an external-job service is installed (`warn`). | Activate it after the cutover (`npm run daski:async-admission -- --activate`). |
| `RUNTIME_INSTANCES` | A running instance is at another schema epoch or has no external-job worker, or its worker heartbeat is older than 60 seconds. | Stop older processes; restart a stalled one. |
| `LEGACY_EXECUTIONS` | Pre-R1 executions are still `executing` without a lease (task ids listed). | Reconcile their product mutations, then `npm run daski:cutover -- --resolve-legacy --old-processes-stopped`. |
| `SYNC_EXECUTION_LEASES` | Synchronous executions hold expired leases (`warn`); a running process fails them as `provider_execution_abandoned`. | Start a compatible process if none runs; reconcile before retrying a mutation. |
| `SUPPLIER_OPERATIONS` | Supplier-journal entries are still `intent` or `ambiguous` (core's own external-job start entries are excluded: core reconciles them, and `EXTERNAL_JOBS` reports their start ambiguity). | Reconcile against the product's authoritative state; never repeat a mutation blindly. |
| `EXTERNAL_JOBS` | Unfinished external jobs raise the servicing codes below (`fail` for a missing handler or key or an invalid result, `warn` otherwise); without a heartbeating worker they also raise `external_job_worker_stopped`. | See "External-job servicing health". |
| `RUNTIME_CATALOG` | An installed paid skill has no promoted runtime listing yet (`warn`), or the catalog or standard-rail configuration does not load (`fail`). | Install the Daski-issued bundle; never edit catalog rows. |
| `RETAINED_OBLIGATIONS` | This build could not service an obligation it would take over (same reasons as the boot refusal below), or the check was not performed for missing standard-rail values (`skip`). | See the reasons table below; never delete claims or quotes. |

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

If boot or the importer refuses with `retained listing obligations are not
serviceable by this build: 0x…abcd (<reason>)`, this build cannot service an
order it would take over (see `docs/configuration.md`):

| Reason | Fix |
| --- | --- |
| `signing key not retained` | Orders of that listing version were admitted under a previous wallet; add its key to `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS`. |
| `skill_not_installed` | The version has quotes, any of which may still back a first dispatch, but the build no longer installs the service or skill; restore it. |
| `definition_invalid`, `schema_invalid` | The version no longer materializes against this build's global policy or schema compiler; do not edit the catalog, restore the matching configuration. |
| `listing version not installed` | A claim or quote names a version absent from the catalog; reinstall its bundle rather than deleting rows. |
| `external-job adapter <service>@<version> not installed` | An unfinished external job was admitted under, or a quote was sold by, an adapter version this build no longer has (the order of such a quote runs with that version); keep it as the current adapter or in `previousExternalJobAdapters` while its jobs run or its quotes are kept (every quote is kept). A rollback to a build without the version a newer build sold with is refused the same way; give the rollback build that version in `previousExternalJobAdapters`. |
| `encryption key <id> not configured` | An unfinished job's stored state names a key this build lacks; restore it (after a rotation, in `PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS`). |
| `no active encryption key for unfinished external jobs` | Unfinished jobs may still need a job reference or result candidate sealed, but `PROVIDER_DATA_ENCRYPTION_KEY` is not set; configure an active key (a previous key alone only reads). |
| `no active encryption key to admit the orders of open external-job quotes` | Quotes an external-job adapter version sold may still be dispatched, and admitting each order seals its input, but `PROVIDER_DATA_ENCRYPTION_KEY` is not set; configure an active key. |
| `control profile 0x…abcd not retained` | Quotes of that listing version were issued under a control profile this build neither uses nor retains, and their orders' first dispatches still carry it; list it in `STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES`. |

Never delete claims or quotes to pass the check.

If boot refuses with `running instances sell external-job adapter versions
this build cannot resume: <service>@<version>`, async admission is on and an
older running instance may still admit jobs under that version, which this
build could never resume once the older instances stop. Keep the version in
`previousExternalJobAdapters` for this rollout, or stop the older instances
before starting this build.

If boot logs `listing commitment drift` (diagnostic `listing_contract_drift`),
this build's published skill contract changed after the installed bundle was
issued. New quotes for that listing version stop with
`503 {"error":"quote_unavailable","reason":"contract_drift"}`; funded orders,
status and lifecycle reads keep being serviced with the admitted definition.
A changed fixed price is such a drift: the head's funded orders are served at
the admitted price, never refused. The process stays online so Daski can read
the new AgentCard. Request, review, and install a replacement bundle; sales
resume at the next boot.

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

`permission denied for schema ...` at boot after a pre-R1 image was started
with a superuser migration URL means its privilege reset took over the
schema. As a superuser, run `ALTER SCHEMA <schema> OWNER TO <migration
principal>` and `ALTER DEFAULT PRIVILEGES FOR ROLE <that superuser> IN SCHEMA
<schema> REVOKE ALL ON TABLES FROM <runtime principal>`, then restart this
build, which reapplies the reviewed grants. No provider row was changed.

`permission denied for table ...` under separate principals means the runtime
role is missing a reviewed grant. Boot reapplies the allowlist in
`src/core/db/runtimePrivileges.ts` through `MIGRATION_DATABASE_URL`; confirm
that variable names the schema owner, then restart. Never grant the runtime
role ownership, `DELETE`, or DDL to work around it.

An applied migration checksum mismatch means a tracked migration was edited
after use. Restore it exactly and add a new numbered migration for the change.

## Async admission is not activated

`npm run daski:async-admission -- --activate` exits 1 and leaves the switch
off unless every check in its JSON report passes:

| Check | Meaning |
| --- | --- |
| `compatibility_barrier` | The database is not at this build's schema epoch or the barrier is incomplete. Boot this build (it migrates), then retry. |
| `legacy_executions` | Pre-R1 executions still await the cutover; run `npm run daski:cutover` first. |
| `retained_obligations` | This build cannot service an obligation (see the boot refusal below). |
| `compatible_workers` | No running instance runs the external-job worker, or an older process (without the worker, or at another schema epoch) still runs. Stop it, start this build, retry. |
| `encryption_keys` | `PROVIDER_DATA_ENCRYPTION_KEY` is not configured for the command; external jobs cannot be sealed without it. |
| `external_job_services` | A running instance does not declare an external-job adapter version that new sales, a quote or an unfinished job need (an older build); stop it and run this build. |

## Startup refuses the database schema

| Message | Cause and fix |
| --- | --- |
| `provider compatibility barrier: this session declares no supported runtime epoch` | A process without this build's epoch marker wrote a provider table or read `_migrations`: a pre-R1 image (expected; it cannot boot or change rows against an upgraded database), a pooler that dropped the startup `options`, or a maintenance session without `PGOPTIONS='-c daski.runtime_epoch=1'`. Stop old processes; connect directly or forward `options`. |
| `runtime epoch N is older than schema epoch M` | An older build is running against a schema an incompatible newer build migrated. Run a build that supports epoch M; do not lower the epoch. |
| `database schema epoch M is newer than this build supports (N); refusing to start` | The same, caught at boot before any mutation. Roll forward rather than back. |
| `compatibility barrier is incomplete` | A barrier trigger was disabled or dropped, or `_migrations` lost its forced row security. Restore it from migration 005; never boot with it removed. |
| `database sessions do not carry this build's runtime-epoch marker` | The runtime connections lost the marker (see `docs/configuration.md`). |

## Reading `/health/ready`

Liveness (`/health/live`) only proves the process exists. `/health/ready`
answers in three parts, and only the first decides its status code:

```json
{
  "status": "ready",
  "checkedAt": "<ISO time>",
  "reads": { "status": "ok", "codes": [] },
  "admission": { "status": "open", "codes": [] },
  "servicing": { "status": "ok", "codes": [] }
}
```

- `reads` (the status code: 200 `ready`, else 503 `not_ready`): whether this
  process can serve funded orders' persisted status and artifact reads and
  their dispatch reconciliation. Route traffic on it.
- `admission` (`open`, `limited` or `stopped`): whether new sales are
  taken. The process refuses new quotes itself while admission is stopped,
  so a product, chain or worker outage never takes reads off the network.
  It covers process-wide prerequisites, paused skills and drifted listings;
  a listing at capacity or with an invalid result mapping refuses quotes
  with that `reason` without changing it.
- `servicing` (`ok` or `degraded`): owed work that needs attention (see the
  next section). It never changes the status code.

`/health/ready` never waits on a product: if a readiness probe is still
running after a quarter second, admission reports the last completed probe
(`readiness_pending` before the first). `/health/admission` returns the same
report with 200 only while admission is `open`; use it for alerting and to
gate promotion of a release whose sales were already open, never for routing
(the first async-admission activation needs the new build running first).

| Part | Code | Meaning and fix |
| --- | --- | --- |
| reads, admission | `database_unavailable` | PostgreSQL does not answer; see "PostgreSQL is unreachable". |
| reads, admission | `schema_epoch_unsupported` | The database's schema epoch is not this build's (a newer incompatible build migrated it). Run a build that supports it; never lower the epoch. |
| admission | `identity_unverified` | The provider wallet/ERC-8004 binding check is failing or stale (`READINESS_MAX_AGE_SECONDS`): RPC reachability, wallet and agent id. |
| admission | `rail_unverified` | Standard-rail chain/evidence verification is failing or stale: RPC, reviewed code hashes, contract coordinates, finality. |
| admission | `no_services` | No service is registered in `src/providerServices.ts`. |
| admission | `readiness_pending` | The first readiness probe has not finished yet (a product check can take up to three seconds); retry. |
| admission | `service_unready` | A service's bounded `readiness` check returned false, threw or timed out: the product dependency. |
| admission | `sales_paused` | A skill declares `acceptingNewOrders: false`; its quotes answer `sales_paused`. |
| admission | `contract_drift` | Some listing versions stopped for drift (see "Global policy or runtime bundle is rejected"). |
| admission | `async_admission_off` | An external-job service is installed but the switch is off (`npm run daski:async-admission`). Funded external-job dispatches not yet admitted are refused too (retryably). |
| admission | `encryption_key_missing` | An external-job service is installed but `PROVIDER_DATA_ENCRYPTION_KEY` is not set; as for the switch, unadmitted funded external-job dispatches are refused. |
| admission | `external_job_worker_stopped` | This process's external-job worker is not claiming work; external-job sales stop. |

`admission.status` is `stopped` when nothing can be sold (complete
readiness failed, or every installed service is an external-job service
whose sales stopped), `limited` when only some listings or modes stopped,
and `open` otherwise. Check structured application logs by event/error
class for the cause; do not route paid traffic based on liveness.

## External-job servicing health

`/health/ready` reports `servicing: {status: "ok" | "degraded", codes}` for
the external-job worker of this process and the unfinished jobs it inspects
every 15 seconds (SELECT only; counts appear in the log line `External-job
servicing health changed`, never inputs, references or keys), plus
`legacy_executions_pending`. Servicing health never changes the readiness
status code: a stopped worker stops new external-job quotes
(`external_jobs_unavailable`) but persisted status and artifact reads stay
routable, and a slow upstream job is never a reason to restart the process.
A worker waiting hours on a pending job, heartbeating
(`provider_runtime_instances.worker_heartbeat_at`) with the job's next poll
scheduled, reports no code. `npm run doctor -- --database` reports the same
conditions for the whole database (see the doctor codes above).

| Code | Meaning | Remedy |
| --- | --- | --- |
| `legacy_executions_pending` | Rows a pre-R1 image left executing await the stop-and-drain cutover; they show `working`. | Follow `docs/onboarding.md` (`npm run daski:cutover`). |
| `external_job_worker_stopped` | This process's worker has not completed a claim round for a minute (typically the database is unreachable) or was stopped. | Restore the database or restart the process; due work resumes from PostgreSQL. |
| `external_job_lease_stale` | A job lease expired more than one lease length ago and nobody reclaimed it. | Check that a compatible worker runs and can resume the job's adapter version (see the next codes). |
| `external_job_overdue` | Unfinished work is past its fulfillment deadline. It stays `working` and keeps polling or reconciling at the overdue cadence; nothing new is started. | Check the product for the original jobs. Lite cannot close or refund them. |
| `external_job_start_ambiguous` | Starts whose outcome is unknown are reconciling through `recoverStart` (`last_error_code` `recover.*`; `recover.restart_settling` while a restart on proven absence waits for the previous start to settle). | If it persists, check that the product's lookup by order key works. |
| `external_job_result_invalid` | A terminal result failed its admitted contract (see above). | Repair the mapping. |
| `external_job_failing` | A job's last ten or more calls failed. Backoff applies; the job is never failed for it. | Check the product's availability and the adapter's error mapping. |
| `external_job_handler_missing` | An unfinished job names an adapter version this build cannot resume. | Restore that version (boot normally refuses this build). |
| `external_job_key_missing` | An unfinished job's stored state names an encryption key this build lacks, or this process has no active key (its worker then claims nothing). | Restore the key, or set `PROVIDER_DATA_ENCRYPTION_KEY` on every replica (boot normally refuses this build while jobs are unfinished). |

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
  `maxOpenOrders`; new sales resume as they finish;
- `contract_drift`: the served skill contract differs from the installed
  bundle (see above);
- `external_jobs_unavailable`: an external-job listing while the
  async-admission switch is off, `PROVIDER_DATA_ENCRYPTION_KEY` is not set or
  the process runs no external-job worker; and
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
- `outcome_policy`/`self_purchase`: the listing version is not installed (or
  its service or skill is not, or the external-job adapter version that sold
  the order's quote), or the payer is a provider wallet;
- `quote_window`/`price`: the forwarded `QuoteV1` or the persisted provider
  quote it names does not bind this order (unknown or zero quote hash,
  different request, payer or window), or the amount differs;
- `evidence`: chain evidence, settlement timing (judged by the deposit block
  timestamp), sanctions, or evidence already admitted for another order; and
- `service_unavailable`: provider readiness or the database failed before
  anything was admitted, or, for an external-job listing, async admission is
  off or no encryption key is configured (the log line `External-job dispatch
  refused before admission` names `async_admission_off` or
  `encryption_key_missing`). Product readiness never refuses an external-job
  dispatch: the admitted job waits for the product.

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
| `409 unsupported_action` | `input`, `cancel` and `support` are not implemented by this starter; nothing happened. Use `provider-full` for them. The buyer sees this refusal by name only through the companion gateway revision (`docs/releasing.md`); an older gateway reports it as a provider error. |
| `503 lifecycle_unavailable` | Database, signing or contract-account RPC failure, a busy or rate-limited servicing call, or a stored result that no longer matches its frozen hash (logged as `terminal_identity_unverifiable`). Retry; a payer-signed retry needs a fresh authorization. |
| `401 lifecycle_rejected` / `grant` or `signature` | The grant is not a current `ProviderLifecycleGrantV1` for this provider audience signed by `STANDARD_RAIL_GATEWAY_SIGNER` as `gateway-lifecycle`. Check the environment, chain, audiences and signer. |
| `403 lifecycle_rejected` / `binding` or `authorization` | The grant does not bind this call, a read capability was used for another action or scope, or the payer signature is invalid for the order's payer (contract accounts need `PAYER_ACCOUNT_TYPES=eoa,contract`). |
| `404 lifecycle_rejected` / `unknown_task` | No claim for the order and task under this gateway audience. |

## Product call times out or is ambiguous

A synchronous adapter has a hard 50-second budget and should set a smaller
product timeout. A known definitive product rejection can map to a stable
failed result. A disconnect/timeout after a mutation may have landed is
ambiguous.

Use the product's idempotency key and authoritative read to reconcile before
retrying. If that cannot be completed during the dispatch, the operation does
not fit synchronous mode: run the product's own job in external-job mode,
where core journals the start and reconciles it through `recoverStart`, or
use `provider-full` for provider-owned workflows. Never label an unknown
outcome successful or blindly repeat the mutation. An external-job start that
throws or times out is always reconciled with the original key; nothing
starts it again until `recoverStart` proves that safe.

## Same order returns a different result or is rejected

An exact same signed dispatch returns the persisted state and attestation,
re-signed with a fresh observation, even after its envelope expired. A
different envelope for an order that already has a claim is never admitted:
it gets the ambiguous `503`, and status for its hash answers `409
binding_conflict`. The original claim stays authoritative; reconcile with the
original dispatch hash.

After a provider crash or stall, an interrupted `executing` row stays
`working` until its execution lease expires (at most 30 seconds after the
last renewal), then any running process fails it with
`provider_execution_abandoned`. A restart never fails another process's live
call. The supplier journal is left as it was, so reconcile a possibly applied
product mutation before retrying it. The minimal runtime must have one active
replica. A synchronous call is never resumed; when the work must survive a
restart, it is a product job for external-job mode (its worker resumes it
from PostgreSQL) or a provider-owned workflow for `provider-full`.

If boot warns `Pre-R1 executions await the stop-and-drain cutover`, rows a
pre-R1 image left executing are still open: they have no lease, show
`working`, and are resolved only by the cutover in `docs/onboarding.md`.

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

## An external job stays `working` with `result_invalid`

The product answered terminally, but the adapter's mapping failed the
listing version's admitted `resultSchema` (or core's bounds or the
passive-output rule). That is an integration error, not proof the product
failed: the job stays `working`, nothing is signed as completed, the job
keeps only retrieving its result (an immediate terminal start reconciles
through its original key; nothing is started again), and the log line
`External job result failed its admitted result contract` names the task and
a stable `diagnostic` with schema keywords, never the result. The rejected
result is kept encrypted on the job row when it fits the 1 MB bound. New
quotes for that skill answer `503 quote_unavailable` /
`invalid_result_mapping` while any unfinished job of the adapter version new
sales use carries the diagnostic.

Fix the mapping. When the job reference format is unchanged, keep the adapter
`version`: the next retrieval of the same report then completes the job,
clears the diagnostic and resumes sales. If the report can no longer be
retrieved, the job stays nonterminal (lite has no operator workflow to close
it); move new sales to a new adapter version and keep the old one in
`previousExternalJobAdapters` so that job is still serviced.

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
