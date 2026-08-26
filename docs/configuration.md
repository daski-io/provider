# Configuration

Copy `.env.example` to `.env` for local work. Production secrets belong in the
hosting platform's secret manager, not in Git, images, logs, support bundles,
or agent prompts.

Configuration fails closed at startup. The Base chain, audiences, wallet,
outcome, contracts, and hashes form one coordinated release set; do not mix
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

## Chain and identity

| Variable | Purpose and rule |
| --- | --- |
| `CHAIN_ID` | `84532` for Base Sepolia or `8453` for Base Mainnet. |
| `BASE_RPC_URL` | Primary credential-free HTTPS Base RPC. Put credentials in a provider-side proxy, not the URL. |
| `BASE_RPC_FALLBACK_URLS` | Optional comma-separated credential-free HTTPS RPCs. |
| `PROVIDER_WALLET_PRIVATE_KEY` | Non-zero 32-byte `0x` private key. Secret; use a dedicated environment wallet. |
| `PROVIDER_AGENT_ID` | Unsigned decimal ERC-8004 agent id coordinated during onboarding. |
| `IDENTITY_REGISTRY_ADDRESS` | Reviewed registry address; canonical address required on Mainnet. |
| `USDC_ADDRESS` | Reviewed Circle USDC address; canonical address required on Mainnet. |

Never reuse Testnet keys or databases on Mainnet. The wallet key signs provider
offers/terminal attestations and must be separated from product credentials.

## Daski standard rail

| Variable | Purpose and rule |
| --- | --- |
| `STANDARD_RAIL_ENVIRONMENT` | Normally `testnet` or `mainnet`; must match every signed envelope. |
| `STANDARD_RAIL_GATEWAY_SIGNER` | Reviewed gateway protocol signer. Used for dispatch and fixed quote verification. |
| `STANDARD_RAIL_GATEWAY_AUDIENCE` | Exact signed gateway audience; normally the gateway origin. |
| `STANDARD_RAIL_PROVIDER_AUDIENCE` | Exact signed provider audience; normally `BASE_URL`. |
| `STANDARD_RAIL_OUTCOMES_JSON` | Daski-issued gzip/base64 outcome configuration for the exact launch-policy set. Do not edit or re-encode. |
| `STANDARD_RAIL_FINALITY_CONFIRMATIONS` | Positive evidence-finality requirement; default 12, coordinated with Daski. |
| `REPUTATION_STORAGE_ADDRESS` | Reviewed reputation contract. |
| `EAS_ADDRESS` | Reviewed EAS contract. |
| `EAS_RUNTIME_CODE_HASH` | Non-zero reviewed EAS runtime hash. |
| `EAS_OUTCOME_SCHEMA_UID` | Reviewed reputation outcome schema UID. |
| `SANCTIONS_ORACLE_ADDRESS` | Reviewed sanctions oracle used for fail-closed participant checks. |

`STANDARD_RAIL_OUTCOMES_JSON` is not ordinary editable configuration. It pins
the outcome/service/skill, request schema, fixed price, capacity/deadline,
token/splitter provenance, commission/payee, controlled wallets, evidence
policy, and provider attestation key. Ask Daski for a new full set after any
reviewed contract change.

The `standard-rail:sign-offer` command reads an unsigned
`ProviderOutcomeOfferV1` JSON envelope from standard input after `npm run build`
and writes the wallet-signed form. Run it only as part of the reviewed
onboarding handoff; its output is a signed security artifact.

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
| `HTTP_REQUEST_TIMEOUT_MS` | Request timeout, default `60000`. Keep above the 50-second adapter budget. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | Keep-alive timeout, default `5000`. |
| `HEALTH_READINESS_CACHE_MS` | Readiness cache, default `5000`. |
| `READINESS_MAX_AGE_SECONDS` | Maximum age of chain/identity readiness evidence, default `180`. |

Mainnet bypass/proxy CIDRs must be IPv4 `/24` or IPv6 `/64`, or narrower.

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
| Testnet | Base Sepolia, dedicated wallet/product sandbox, stable HTTPS, reviewed Testnet artifact set. |
| Mainnet | Base, `production`, canonical contracts/USDC, distinct DB roles, verify-full TLS, reviewed proxy/edge, live product, dummy removed, Daski whitelist. |
