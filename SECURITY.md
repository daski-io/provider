# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
[security advisory form](https://github.com/daski-io/provider/security/advisories/new)
and include the affected commit, impact, safe reproduction steps, and any
suggested mitigation. Do not include real credentials, private keys, customer
data, signed authorization material, or raw production output.

Fork operators must replace this destination with a private security channel
they monitor. Daski cannot receive or respond to vulnerability reports for an
independently operated fork.

## Supported versions

Before the first stable release, only the latest commit on `develop` is
supported for testing. After releases begin, supported versions will be listed
in their GitHub release notes. Never infer support from a branch name alone.

## Trust boundaries

The provider accepts paid work only through the signed standard Exact-EVM rail.
Core verifies the gateway signer, environment, chain, audiences, expiry,
service/outcome bindings, request hashes, payer, quote, payment evidence,
release evidence, sanctions state, and replay state before invoking a service.
The service adapter must not duplicate or bypass that admission decision.
Daski's verified payment is the purchase: an adapter never charges the buyer
again by paying an upstream x402 or other paid endpoint, and never trusts a
caller-asserted "already paid" flag.

The provider still trusts its own:

- deployed code and runtime secret store;
- PostgreSQL integrity and availability;
- reviewed Base RPC sources and contract coordinates;
- Daski-issued signer and outcome bindings; and
- explicitly configured product API or MCP dependency.

A compromised provider host, database owner, wallet, or upstream product can
violate fulfillment. This starter is technical infrastructure, not a provider's
legal, compliance, custody, incident-response, or business-continuity program.

## Product integration rules

- Map each skill to one fixed reviewed operation. Never proxy a buyer-selected
  URL, method, MCP server, tool name, credential, or arbitrary header.
- Use the reviewed outbound HTTP boundary with HTTPS, DNS/IP checks, timeouts,
  response-size limits, concurrency limits, and endpoint pinning.
- Strictly parse product responses; do not pass raw upstream errors or payloads
  into public errors or logs.
- Use stable idempotency keys and journal intent before non-convergent external
  mutations. Reconcile authoritative product state after ambiguity.
- If an operation cannot reconcile and finish inside the synchronous budget,
  run it as an external job when the product's own job can be started under
  core's stable key and found again by it, or use `provider-full`; never
  weaken terminal or restart guarantees.
- External-job input and job references are stored only as authenticated
  envelopes under `PROVIDER_DATA_ENCRYPTION_KEY`. Keep that key and every
  previous key an unfinished job names in the secret manager; never log or
  publish a bearer job URL.
- Store credentials only in an approved runtime secret manager. `.env` is for
  local development and must never be committed.

## Operational minimum

- Use Node 24, the committed lockfile, and the pinned non-root Docker image.
- Use PostgreSQL 16+; production requires verified TLS and separate migration
  and runtime principals.
- Expose stable HTTPS through a reviewed reverse proxy and edge rate limiter.
- Keep one active application replica for this minimal runtime and route
  traffic only while `/health/ready` passes (read serviceability). New
  sales stop in-process: all of them while its `admission` part is
  `stopped`, the named listings or modes while it is `limited`.
- Separate Testnet and Mainnet wallets, databases, origins, product accounts,
  and Daski-issued artifacts.
- Run the documented type, lint, architecture, docs, skill, test, audit, build,
  secret, and artifact scans before release.

Mainnet is whitelisted and coordinated. Passing local gates or receiving a
signed artifact does not grant Mainnet admission.
