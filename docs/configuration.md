# Configuration

Copy `.env.example` to `.env` for local work. Production secrets belong in the
hosting platform's secret manager, not in Git, images, logs, support bundles,
or agent prompts.

Configuration fails closed at startup. The Base chain, audiences, wallet,
runtime catalog, contracts, and hashes form one coordinated release set; do not mix
Testnet/Mainnet or revisions.

## Provider and runtime

| Variable | Purpose and rule |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`; Base Mainnet requires `production`. |
| `PORT` | HTTP port, default `4000`. |
| `DEPLOYMENT_REVISION` | Optional public-safe commit/image identifier, at most 128 characters. |
| `BASE_URL` | This provider's exact public origin; HTTPS in production. Loopback only when `CHAIN_MODE=mock`. |
| `GATEWAY_BASE_URL` | Credential-free HTTPS Daski gateway origin. |
| `CHAIN_MODE` | `live` normally; `mock` only for bounded loopback tests and never production/Mainnet. |
| `PROVIDER_NAME` | Public legal/provider name. |
| `PROVIDER_DESCRIPTION` | Optional public description, at most 2,000 characters. |
| `PROVIDER_WEBSITE_URL` | Optional credential-free HTTPS website. |
| `PROVIDER_ICON_URL` | Optional credential-free HTTPS icon URL. |
| `MARKETPLACE_TERMS_URL` | Daski-provided marketplace terms HTTPS URL. |
| `MARKETPLACE_PRIVACY_URL` | Daski-provided marketplace privacy HTTPS URL. |
| `PROVIDER_TERMS_URL` | Provider's public HTTPS terms. |
| `PROVIDER_PRIVACY_URL` | Provider's public HTTPS privacy notice. |
| `SUPPORT_EMAIL` | Public support address. |
| `SUPPORT_RESPONSE_SLA` | Public support expectation; default `1 business day`. |

URLs must not embed usernames, passwords, tokens, or fragments.

## PostgreSQL

| Variable | Purpose and rule |
| --- | --- |
| `DATABASE_URL` | Required runtime principal. Local Compose value is in `.env.example`. |
| `MIGRATION_DATABASE_URL` | Optional locally; required and distinct in production. Schema-owner principal. |
| `DATABASE_SSL_MODE` | `disable`, `require`, or `verify-full`; production requires `verify-full`. |
| `DATABASE_CA_CERT` | PEM CA bundle used by verified TLS when the system trust store is insufficient. |
| `DATABASE_ACQUIRE_TIMEOUT_MS` | Pool acquisition bound, default 5,000. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Query/statement bound, default 30,000. |
| `DATABASE_IDLE_TX_TIMEOUT_MS` | Idle transaction bound, default 30,000. |
| `DATABASE_POOL_MAX` | Connection pool size, default 10. |
| `DATABASE_APPLICATION_NAME` | PostgreSQL application label, default `daski-provider`. |

Production's runtime principal must not own tables/schema, create schema,
create temporary objects, or have superuser/database/role/bypass-RLS powers.
The migration principal needs schema creation but no cluster-wide powers.
Boot applies privileges and verifies separation when both URLs are provided.
The runtime principal receives only the reviewed per-table statements listed
in `src/core/db/runtimePrivileges.ts`: no `DELETE`, `TRUNCATE`, DDL, or
migration-ledger access, and read-only access to the runtime catalog. A table
added by a later migration stays inaccessible until it is reviewed into that
list. `npm run daski:install-runtime` promotes catalog versions as the
migration principal, and boot prunes settled provider quotes as it
(`docs/architecture.md`).

Every connection this build opens declares its supported schema epoch through
the session setting `daski.runtime_epoch`, sent in the connection's startup
`options` (merged with any `options` already in the URL). The database refuses
provider writes and migration-ledger reads from sessions without it, which is
how pre-R1 processes are excluded (`docs/architecture.md`). A connection proxy
that drops startup parameters therefore fails closed: boot stops with
`database sessions do not carry this build's runtime-epoch marker`. Connect
directly or through a pooler that forwards `options` in session mode.

Synchronous executions hold a 30-second lease renewed every 10 seconds, and
every process sweeps expired leases every 15 seconds (reviewed constants in
`src/core/standardRail/syncLease.ts`, not configuration).

Maintenance sessions that write provider tables or read `_migrations` must
declare the marker explicitly, for example
`PGOPTIONS='-c daski.runtime_epoch=1' psql ...`. A logical backup by the
non-superuser schema owner needs the same setting and
`pg_dump --enable-row-security`, because the ledger forces row security;
restoring that dump needs neither, since its triggers and policy are
recreated after the data. Managed snapshots and superuser dumps are
unaffected. Never set the marker at role or database level
(`ALTER ROLE/DATABASE ... SET`): that would admit pre-R1 processes too.

`npm run doctor -- --database` is an opt-in, read-only diagnostic session:
it connects with `DATABASE_URL`, its startup options carry the epoch marker
and `default_transaction_read_only=on`, and every check runs in one
`REPEATABLE READ READ ONLY` transaction that is rolled back, so PostgreSQL
itself refuses any write. Run it with the deployment's configuration (it
judges handlers and keys against it). The runtime principal is enough for
every check except the migration-ledger comparison, which it reports as not
performed (`docs/troubleshooting.md`).

## Chain and identity

| Variable | Purpose and rule |
| --- | --- |
| `CHAIN_ID` | `84532` for Base Sepolia or `8453` for Base Mainnet. |
| `BASE_RPC_URL` | Primary credential-free HTTPS Base RPC. Put credentials in a provider-side proxy, not the URL. |
| `BASE_RPC_FALLBACK_URLS` | Optional comma-separated credential-free HTTPS RPCs. |
| `PROVIDER_WALLET_PRIVATE_KEY` | Non-zero 32-byte `0x` private key. Secret; use a dedicated environment wallet. |
| `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS` | Optional comma-separated previous wallet keys, kept after a rotation for orders admitted under older listing versions. Secret; never the current key, never repeated. |
| `PROVIDER_AGENT_ID` | Unsigned decimal ERC-8004 agent id coordinated during onboarding. |
| `IDENTITY_REGISTRY_ADDRESS` | Reviewed registry address; canonical address required on Mainnet. |
| `USDC_ADDRESS` | Reviewed Circle USDC address; canonical address required on Mainnet. |

Never reuse Testnet keys or databases on Mainnet. The wallet key signs provider
offers/terminal attestations and must be separated from product credentials.

| Variable | Purpose and rule |
| --- | --- |
| `PAYER_ACCOUNT_TYPES` | Payer accounts accepted for payer-signed lifecycle reads: `eoa` (default) or `eoa,contract`. Must include `eoa`. |
| `PAYER_SIGNATURE_VERIFY_TIMEOUT_MS` | One deadline, default `5000` (500 to 60,000), for a contract account's code lookup, `isValidSignature` call and at most one RPC failover. |

A payer-signed lifecycle read carries the buyer's EIP-712
`OrderActionAuthorizationV1`. An EOA signature (65 bytes, low s) is verified
offline with no RPC. With `contract`, a signature that does not recover to
the payer is checked against the payer's deployed ERC-1271 contract through
`BASE_RPC_URL` and the first `BASE_RPC_FALLBACK_URLS` entry: a read-only
`eth_call` with a 1,000,000 gas bound and a 16 KiB answer bound that must
return exactly `0x1626ba7e` followed by 28 zero bytes; ERC-6492 counterfactual
wrappers are refused, at most eight verifications run at once, and RPC
failure is answered `503 lifecycle_unavailable`, never as an invalid
signature. `CHAIN_MODE=mock` has no RPC, so contract accounts are
unavailable there. Read-capability reads never need the RPC.

## Daski standard rail

| Variable | Purpose and rule |
| --- | --- |
| `STANDARD_RAIL_ENVIRONMENT` | Normally `testnet` or `mainnet`; must match every signed envelope. |
| `STANDARD_RAIL_GATEWAY_SIGNER` | Reviewed gateway protocol signer. Verifies readiness-quote and intake requests, dispatches, status queries, lifecycle grants, and forwarded `QuoteV1` envelopes; each still names its own key id. |
| `STANDARD_RAIL_GATEWAY_ORIGIN` | Credential-free HTTPS origin that scopes the installed runtime catalog. Normally identical to `GATEWAY_BASE_URL`. |
| `STANDARD_RAIL_GATEWAY_AUDIENCE` | Exact signed gateway audience; normally the gateway origin. |
| `STANDARD_RAIL_PROVIDER_AUDIENCE` | Exact signed provider audience; normally `BASE_URL`. |
| `STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES` | Optional comma-separated previous provider audiences that dispatch, status and lifecycle calls for older orders may still name. Quotes and intake use only the current audience. |
| `STANDARD_RAIL_GLOBAL_POLICY_JSON` | Daski-issued JSON containing the signed chain-evidence, active-rail, and capability envelopes plus reviewed global code hashes. Preserve exactly. |
| `STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH` | Reviewed bytes32 provider endpoint/control profile binding. |
| `STANDARD_RAIL_FINALITY_CONFIRMATIONS` | Positive evidence-finality requirement; default 12, coordinated with Daski. |
| `REPUTATION_STORAGE_ADDRESS` | Reviewed reputation contract. |
| `EAS_ADDRESS` | Reviewed EAS contract. |
| `EAS_RUNTIME_CODE_HASH` | Non-zero reviewed EAS runtime hash. |
| `EAS_OUTCOME_SCHEMA_UID` | Reviewed reputation outcome schema UID. |
| `SANCTIONS_ORACLE_ADDRESS` | Reviewed sanctions oracle used for fail-closed participant checks. |

The global policy and runtime bundle are not ordinary editable configuration.
The policy pins gateway-signed chain and rail facts shared by listings. The
bundle pins one service's exact skill contracts, fixed prices, capacity and
deadlines, token/splitter provenance, commission/payee, provider intent, and
runtime commitments. Ask Daski for a new consistent set after any reviewed
contract change.

### External-job state encryption

External jobs persist their buyer input, the upstream job reference and, for a
result that failed validation, a bounded candidate. Each is stored only as an
authenticated envelope (`src/core/security/fieldEncryption.ts`), the same
format provider-full uses for protected data:
`daski:v1:<base64url JSON {v, alg: "A256GCM", kid, purpose, iv, ciphertext, tag}>`,
AES-256-GCM under an HKDF-SHA256 per-purpose key, with the owning record
(table, task id, field, service) bound as associated data.

| Variable | Purpose and rule |
| --- | --- |
| `PROVIDER_DATA_ENCRYPTION_KEY` | Active 32-byte `0x` master key. Secret. Required to admit external jobs and while stored jobs name it; synchronous-only installations need none. Never a provider wallet key. |
| `PROVIDER_DATA_ENCRYPTION_KEY_ID` | Id written into every new envelope, default `primary`; 1 to 64 of `A-Z a-z 0-9 . _ -`. |
| `PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS` | Comma-separated read-only `id=0x<64 hex>` keys for values written before a rotation. Secret. Ids are unique; no material is reused under another id. |

Rotation contract: new values always use the active key and name its id; a
value is read only with the key its own id names. To rotate, configure a new
active key under a new id and move the old one to
`PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS`; keep it there while any unfinished
job names it (finished jobs keep no encrypted state). Keep an active key
while any job is unfinished: it seals the references and candidates those
jobs still produce, and boot refuses without it. Changing a key without
changing its id makes old values fail authentication instead of decrypting
wrongly. Generate a key with `openssl rand -hex 32` and prefix `0x`. Keep keys
out of Git, images, logs, manifests and support material.

### Async admission switch

External-job admission is governed by a database switch that starts off.
Migrations, the importer and boot never turn it on (the runtime role can only
read it, and a static gate keeps every other code path away from the
activation module). Only the operator command changes it:

```bash
npm run daski:async-admission                    # report the switch and its checks (read-only)
npm run daski:async-admission -- --activate      # enable it if every check passes
npm run daski:async-admission -- --deactivate    # turn it off (see docs/onboarding.md before using it)
```

Activation locks the switch and, in the same transaction, requires the
legacy-process barrier at this build's schema epoch (so no pre-R1 process can
run), no pre-R1 execution awaiting the cutover, every retained obligation
serviceable with this build's handlers and keys (unfinished external jobs
included), at least one running instance with every running instance (fresh
heartbeat in `provider_runtime_instances`) a compatible external-job worker,
an active `PROVIDER_DATA_ENCRYPTION_KEY` (`encryption_keys`), and every
running instance declaring every external-job adapter version new sales (of
this build or of any running instance) or unfinished jobs need
(`external_job_services`). It records the checks as evidence. Every process
of this build runs the worker, so stop older processes before activating.
The command never migrates. Deactivation stops new external-job quotes and
also refuses, retryably, funded external-job dispatches not admitted yet;
admitted jobs continue (`docs/onboarding.md`). While the switch is on, boot also refuses a build
that cannot resume an adapter version a running instance still sells, so jobs
admitted during a rolling upgrade never outlive every process that can resume
them. Give every replica the same active key: a process without one claims no
external job.

### External-job worker

| Variable | Default / rule |
| --- | --- |
| `EXTERNAL_JOB_CALL_TIMEOUT_MS` | `30000` (1,000 to 120,000): one bounded `start`, `recoverStart` or `poll` call. |
| `EXTERNAL_JOB_LEASE_SECONDS` | `90` (10 to 3,600): the database lease a call runs under; at least three renewals and at least one call plus two renewals. |
| `EXTERNAL_JOB_LEASE_RENEW_MS` | `20000` (1,000 to 600,000): how often a held lease is renewed. |
| `EXTERNAL_JOB_MAX_CONCURRENT_CALLS` | `4` (1 to 64): database-fenced calls in flight across every process sharing the database. |
| `EXTERNAL_JOB_POLL_INTERVAL_SECONDS` | `60` (5 to 86,400): the ordinary wait between polls of a pending job, unless the product asks for more. |
| `EXTERNAL_JOB_OVERDUE_POLL_SECONDS` | `300` (60 to 86,400): the minimum delay between calls for work past its fulfillment deadline, so overdue work is polled at most this often (less often when the product asks or backoff is longer). |

These are worker defaults, not signed protocol constants. Transient failures
back off from 15 seconds, doubling to at most 30 minutes, with a 10% random
spread on core's own delays; a product's `pollAfterSeconds` or
`retryAfterSeconds` (at most one day) is always honored as a minimum.

### Retained listing versions, keys and audiences

Installing a new bundle supersedes a listing's head but never removes the
older version: an order paid against it, even one first dispatched days
later, is admitted and read with that version's admitted definition (request
and result schemas, price, deadlines and fulfillment window, handler). The
gateway verifies every answer about an order with the keys and sends it to the
audience its checkout snapshot named, so:

- after rotating the provider wallet, list each previous key in
  `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS` until no order admitted under its
  versions remains; answers about those orders are signed with it, never with
  a key the snapshot does not name;
- after moving the public origin, keep the old origin routed to this provider
  and list the old audience in `STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES`
  (the standard-rail paths themselves never change); and
- keep every retained version's service and skill installed while its quotes
  may still be dispatched: up to the quote's window plus the version's
  fulfillment window plus 30 days; and
- keep, while any unfinished external job needs them, the adapter version
  that admitted it (as the current adapter or in
  `previousExternalJobAdapters`) and every encryption key id its stored
  state names (`PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS` after a rotation).

Boot and the importer verify this for every obligation (claims of any state,
quotes that may still be dispatched, and unfinished external jobs) and refuse
with
`retained listing obligations are not serviceable by this build` otherwise,
so an incompatible build cannot take over. Paused sales never block servicing.

The bundle is installed into the append-only PostgreSQL catalog, not placed in
an environment variable:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The path is local to the operator running the command. Keep both the bundle and
global policy out of Git, images, prompts, and ordinary support messages. Run
the importer once per service; an identical commitment is an idempotent no-op.

## HTTP and rate limiting

| Variable | Default / rule |
| --- | --- |
| `RATE_LIMIT_HASH_KEY` | Required high-entropy secret of at least 32 characters, used only to pseudonymize local rate-limit identities. |
| `RATE_LIMIT_GLOBAL_CAPACITY` | `300`. |
| `RATE_LIMIT_GLOBAL_PER_MIN` | `300`. |
| `RATE_LIMIT_RAIL_CAPACITY` | `120`. |
| `RATE_LIMIT_RAIL_PER_MIN` | `120`. |
| `RATE_LIMIT_HEALTH_CAPACITY` | `120` per minute, process-local. |
| `RATE_LIMIT_BYPASS_IPS` | Optional comma-separated reviewed IP/CIDR set; production rejects broad ranges. |
| `EDGE_RATE_LIMIT_VERIFIED` | Mainnet must be `true` only after actual edge controls are reviewed. |
| `TRUST_PROXY_HOPS` | `0` without a proxy; maximum 3. Mainnet requires a reviewed proxy. |
| `TRUST_PROXY_CIDRS` | Trusted proxy IP/CIDR set. Mainnet requires a non-empty narrow set. |
| `HTTP_MAX_CONCURRENCY` | Global in-process concurrency, default `200`. |
| `HTTP_MAX_CONCURRENCY_PER_IP` | Per-client concurrency, default `20`, never above global. |
| `HTTP_HEADERS_TIMEOUT_MS` | Header timeout, default `15000`, never above request timeout. |
| `HTTP_REQUEST_TIMEOUT_MS` | Request timeout, default `60000`. Keep above the 50-second synchronous adapter budget. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | Keep-alive timeout, default `5000`. |
| `HEALTH_READINESS_CACHE_MS` | Readiness cache, default `5000`. |
| `READINESS_MAX_AGE_SECONDS` | Maximum age of chain/identity readiness evidence, default `180`. |

Mainnet bypass/proxy CIDRs must be IPv4 `/24` or IPv6 `/64`, or narrower.

The global and rail limits apply to discovery, quotes and other ordinary
routes. Dispatch, dispatch status and lifecycle reads are servicing calls for
funded orders: they skip the product-readiness gate and both request-charged
limits, and keep the concurrency and body bounds (status and lifecycle bodies
are capped at 64 KiB). A lifecycle call refused for concurrency or by the
failure bucket gets the named `503 lifecycle_unavailable`. Lifecycle has its
own failure bucket, charged only by grants that do not authenticate: its
body carries the buyer's own request, so a transport fault or an invalid
request there never spends a token. Instead,
a shared PostgreSQL bucket per source admits 120 unauthenticated failures
(malformed, wrong-domain or badly signed calls and transport faults) per
minute; verified calls only read it. Middleware refusals of servicing calls
are definite JSON refusals because no handler ran. A new synchronous dispatch
is still refused before admission while provider readiness is down. Behind a
proxy, set `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS` so sources are told
apart, and list the reviewed gateway egress in `RATE_LIMIT_BYPASS_IPS` when its
addresses are known; a source that exhausts its failure bucket is refused
until it refills, gateway calls included.

## Outbound product/RPC policy

| Variable | Default / rule |
| --- | --- |
| `OUTBOUND_TOTAL_TIMEOUT_MS` | `30000`; product-specific calls should usually use a smaller explicit value. |
| `OUTBOUND_MAX_RESPONSE_BYTES` | `5000000`; set smaller per operation. |
| `OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN` | `16`. |
| `OUTBOUND_CIRCUIT_FAILURE_THRESHOLD` | `5`. |
| `OUTBOUND_CIRCUIT_OPEN_MS` | `30000`. |

Add product-specific names beneath the marked section of `.env.example` and
parse them in `src/services/<slug>/config.ts`. Distinguish public configuration
from secrets in the service docs. Never add a switch that lets a buyer select
an endpoint/tool or lets Mainnet use a fake/sandbox dependency.

## Stage summary

| Stage | Required posture |
| --- | --- |
| Offline | No `.env`, database, wallet, or network required. |
| Local | Loopback `BASE_URL`, optional `CHAIN_MODE=mock`, local PostgreSQL; full paid boot still needs artifacts. |
| Testnet | Base Sepolia, dedicated wallet/product sandbox, stable HTTPS, reviewed Testnet artifact set; external-job services also need `PROVIDER_DATA_ENCRYPTION_KEY` and the explicit async-admission activation. |
| Mainnet | Base, `production`, canonical contracts/USDC, distinct DB roles, verify-full TLS, reviewed proxy/edge, live product, dummy removed, Daski whitelist. |
