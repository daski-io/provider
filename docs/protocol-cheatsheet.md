# Protocol cheatsheet

This is an orientation aid, not a substitute for the signed artifacts or core
validators.

## Discovery

| Surface | Purpose |
| --- | --- |
| `/.well-known/agent.json` | Provider-level ERC-8004 discovery |
| `/.well-known/agent-registration.json` | Registration metadata for reviewed onboarding tooling |
| `/agent-cards/<slug>.json` | One service's v1 metadata and hashable v2 service/skill contract |
| `/skills/<slug>.md` | Service documentation |
| `/skills/<slug>/<skill>.md` | Skill documentation |
| `/llms.txt` | Agent-readable documentation index |
| `/standard-rail/outcomes` | Non-secret summary of installed reviewed outcomes |

## Readiness quote and intake

The gateway posts `{request: envelope}` to `/standard-rail/quote` before it
issues a payment challenge. Two artifact types share that URL and the
`gateway-dispatch` signing key; each handler checks its own type and schema
version before trusting the signature.

`ProviderQuoteRequestV1` carries exactly `{outcomeId, listingManifestHash,
requestHash, request, payer}`, where `payer` is lowercase hex or null and
`requestHash = canonicalHash(request)`. Core verifies the envelope domain,
lifetime and signer, the installed listing version, the request schema,
capacity and the optional `requestReadiness` hook, then answers exactly:

```text
outcomeId, listingManifestHash, requestHash, grossAmount, payer,
issuedAt, validBefore, signature
```

`grossAmount` is always the listing's fixed price, `payer` is echoed
literally, the quote lives 120 seconds, and `signature` is the provider
authority's EIP-191 signature of the raw `canonicalHash` of the other seven
fields. That hash is persisted before signing; the gateway carries it in
`QuoteV1.providerQuoteHash`. A quote never starts, reserves, or purchases
product work.

| Refusal | Meaning |
| --- | --- |
| 400 `invalid_quote_request` | Body is not exactly `{request: object}` |
| 401 `quote_rejected` / `envelope` or `signature` | Wrong type, version, domain, lifetime, key id, or signer |
| 409 `quote_rejected` / `outcome_policy`, `binding`, `price` | Unknown listing version, request-hash or payer-format mismatch, unreleasable price |
| 422 `quote_rejected` / `request_invalid` + `fieldErrors` | Schema or readiness refusal; `[{path, rule, message, allowedValues?}]` |
| 503 `quote_unavailable` / `capacity`, `sales_paused`, `service_unavailable` | New sales are temporarily stopped; retry later |

New quotes stop when a listing version's nonterminal tasks reach its
`maxOpenOrders`. That limit never refuses an already-funded dispatch.

`ProviderIntakeRequestV1` (`{outcomeId, listingManifestHash, requestHash,
request}`) returns signed discovery: the published `requestSchema`, field
errors of the partial request against it, empty `requiredFields`,
`selectorsRequired` and `normalizedSelectors`, and `supported: null`. Lite
services declare no contextual intake. Intake creates no quote.

## Paid order

The gateway sends `/standard-rail/dispatch` with exactly:

```text
dispatch       SignedEnvelope<StandardRailDispatchV2>
quote          SignedEnvelope<QuoteV1>
request        object matching the reviewed JSON Schema
evidenceBundle StandardEvidenceBundleV2 (deposit + release)
```

Every POST carries a fresh envelope (new nonce and window); the original
`QuoteV1` is forwarded each time, possibly long after it expired. Core
authenticates the envelope, then looks up the claim for (gateway audience,
order) before anything else:

- an exact replay of an admitted envelope returns that claim's current
  signed snapshot, even after the envelope expired;
- a different envelope for an admitted order never replaces it and is
  answered ambiguously; and
- only for a new claim does core verify that the envelope is current, the
  outcome and payer bindings, `QuoteV1`, the persisted provider quote named
  by `QuoteV1.providerQuoteHash` (outcome, listing, request hash, amount,
  payer compared as addresses, and a provider window covering the gateway
  window), the request schema, readiness, chain evidence and sanctions.

There is no quote-age limit: settlement timeliness is judged by the deposit
block timestamp against the `QuoteV1` window. A claim cannot commit at or
after the dispatch envelope's `validBefore`; PostgreSQL enforces that at
commit time. Funded dispatches are never refused for listing capacity or
paused sales. While provider readiness is down, a new synchronous dispatch is
refused before admission so the gateway retries it later.

A successful dispatch or status answer has exactly these keys:

```text
taskId, dispatchHash, signature, state, operations
terminalAttestation   (completed and failed only)
```

`state` is `working` while the synchronous execution runs (stored as
`executing`), then `completed` or `failed`; there is no inline `result`.
`operations` is `{schemaVersion: 1, revision, observedAt, fulfillment: null,
support: null, recovery: null}`: the revision is persisted per task and stays
0 for this constant projection, while `observedAt` is the database clock at
each read. `signature` is the provider authority's EIP-191 signature of the
raw `canonicalHash({taskId, dispatchHash, state, operations})`, recomputed
for every answer. `terminalAttestation` is `{payload: {taskId, dispatchHash,
state, resultHash, completedAt}, signature}`, where `resultHash` is the
`canonicalHash` of the stored result and the signature is EIP-191 over the
raw `canonicalHash(payload)` by the terminal attestation key.

| Provider knowledge | Answer |
| --- | --- |
| Definite refusal before any admission | 4xx/5xx `{"error":"dispatch_rejected","reason":...}`; the gateway retries with a new envelope |
| Admission exists, or its commit is uncertain | The signed snapshot, else an empty-body `503` so the gateway status-polls the original hash |
| Signed, fresh status query; no claim for the order | Exactly `404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}` |

Refusal reasons: `validator`, `signature`, `envelope_lifetime`,
`outcome_policy`, `self_purchase`, `quote_window`, `price`, `evidence`, and
`service_unavailable`. Transport faults on dispatch or status (wrong media
type, compression, duplicate keys, oversize bodies, concurrency or abuse
limits) are answered with the empty `503`, never a JSON refusal.

The gateway reconciles with `/standard-rail/dispatch/status` and a signed
`DispatchStatusQueryV1` `{orderId, dispatchHash, issuedAt, validBefore}`. Its
signature and freshness are verified before any lookup. A different claim for
the order answers `409 dispatch_status_rejected/binding_conflict`; a bad
signature, stale or malformed query, unreadable database or signing failure is
never the no-claim answer. Status reads are one indexed read: no product
call, no write, no purchase rate limit, and no product-readiness gate.

## Service result

Successful service execution returns:

```json
{
  "status": "completed",
  "message": "Optional public summary",
  "artifacts": [
    {
      "name": "result",
      "mimeType": "application/json",
      "data": { "example": true }
    }
  ]
}
```

A controlled failure returns:

```json
{
  "status": "failed",
  "errorCode": "stable_product_error",
  "message": "Safe public explanation"
}
```

Do not return pending states, access-bearing product credentials, raw upstream
responses, or unbounded artifacts. Core caps the total encoded result at 1 MB.

## Runtime-listing coordination

The following must agree exactly:

- service and skill ids in the installed `ServiceModule`;
- closed request/result schemas, fixed atomic-USDC price, capacity, and
  deadlines in the published v2 AgentCard contract;
- the provider-authorized intent and Daski-signed runtime bundle installed in
  `provider_runtime_listing_versions`;
- token, payee, splitter/contract provenance, and hashes reproduced from the
  runtime bundle plus `STANDARD_RAIL_GLOBAL_POLICY_JSON`; and
- provider wallet, identity, public audience, environment, and chain.

A mismatch is an import, boot, or dispatch failure. Request a new coordinated
bundle; never loosen validation or edit an issued artifact/catalog row.

## Terms

| Term | Meaning |
| --- | --- |
| Provider | The organization operating this runtime and its ERC-8004 identity |
| Supplier | The upstream API, MCP server, or product, even if provider-owned |
| Service | One coherent public product boundary |
| Skill | One buyer-visible fixed operation |
| Runtime listing | The reviewed listing/payment coordinate for a skill |
| Gateway | Daski entrypoint that admits payment and signs provider calls |
| Payer | Wallet authorized and verified by the standard rail |
