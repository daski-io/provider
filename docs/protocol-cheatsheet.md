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
| 503 `quote_unavailable` / `capacity`, `sales_paused`, `service_unavailable`, `contract_drift` | New sales are temporarily stopped; retry later (`contract_drift`: the served skill contract differs from the admitted bundle until a replacement is installed) |

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

A new claim is verified against the listing version the dispatch names,
looked up among every installed version by its runtime commitment hash: an
order paid against a version that has since been superseded is admitted with
that version's schemas, price and deadlines. Every answer about an order is
signed with the provider wallet its version recorded (a retained previous
key after a rotation), and servicing calls may name a retained previous
provider audience.

`state` is `working` while the synchronous execution runs (stored as
`executing`), then `completed` or `failed`; there is no inline `result`.
`operations` is `{schemaVersion: 1, revision, observedAt, fulfillment: null,
support: null, recovery: null}`: the revision is persisted per task and stays
0 for this constant projection, while `observedAt` is the database clock at
each read. `signature` is the provider authority's EIP-191 signature of the
raw `canonicalHash({taskId, dispatchHash, state, operations})`, recomputed
for every answer. `terminalAttestation` is `{payload: {taskId, dispatchHash,
state, resultHash, completedAt}, signature}`, where `resultHash` is the
`canonicalHash` of the result frozen at the terminal transition (see Service
result) and the signature is EIP-191 over the raw `canonicalHash(payload)` by
the terminal attestation key.

| Provider knowledge | Answer |
| --- | --- |
| Definite refusal before any admission | 4xx/5xx `{"error":"dispatch_rejected","reason":...}`; the gateway retries with a new envelope |
| Admission exists, or its commit is uncertain | The signed snapshot, else an empty-body `503` so the gateway status-polls the original hash |
| Signed, fresh status query; no claim for the order | Exactly `404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}` |

Refusal reasons: `validator`, `signature`, `envelope_lifetime`,
`outcome_policy`, `self_purchase`, `quote_window`, `price`, `evidence`, and
`service_unavailable`. Every refusal is sent only after an authoritative read
still shows no claim for the order; a concurrently admitted delivery is
answered with its snapshot instead. Transport faults (wrong media type or
charset, compression, duplicate keys, oversize bodies) and concurrency or
abuse limits are JSON refusals from middleware: the request never reached a
handler. Gateway signatures must use the canonical encoding (lowercase
65-byte hex, low s, v 27 or 28), so one signed dispatch has one hash.

The gateway reconciles with `/standard-rail/dispatch/status` and a signed
`DispatchStatusQueryV1` `{orderId, dispatchHash, issuedAt, validBefore}`. Its
signature and freshness are verified before any lookup. A different claim for
the order answers `409 dispatch_status_rejected/binding_conflict`; a bad
signature, stale or malformed query, unreadable database or signing failure is
never the no-claim answer. Status reads are one indexed claim read plus the
abuse guard's read-only bucket lookup: no product call, no write, no
request-charged rate limit, and no product-readiness gate.

## Buyer lifecycle

A buyer reads an order through the gateway, which proxies the call to
`/standard-rail/lifecycle` with header `daski-order-status-view: 1` (accepted;
lite adds no input or document views) and exactly:

```text
orderId, providerTaskId, action, request, authorization, grant, payer, gatewayAudience
```

Core verifies the `ProviderLifecycleGrantV1` `grant` before reading anything
else: type, version, environment, chain, provider audience, key id
`gateway-lifecycle` and its signer, canonical signature, lifetime at most 120
seconds, and that its payload `{orderId, providerTaskId, action, requestHash,
authorizationHash, payer}` binds this call (`requestHash =
canonicalHash(request)`, `authorizationHash = canonicalHash(authorization)`,
payer compared as an address, `gatewayAudience` the configured gateway). Only
a failure of that check is unauthenticated. The gateway forwards the buyer's
own `request` object, so its shape and size are judged afterwards, as the
gateway's call. Then core interprets `authorization`:

- `{"type": "DaskiReadCap", "scope": action}` authorizes only `status` or
  `artifact` with exactly that scope and an empty request; it never
  authorizes anything else, even under a valid grant;
- any other action (`input`, `cancel`, `support`) is answered as
  unsupported here, before a payer signature is checked or anything is
  looked up;
- for a read, it is otherwise the buyer's nine-field
  `OrderActionAuthorizationV1`, which must name this order, action, `POST`,
  an `/orders/<handle>/actions/<action>` URI on the gateway origin and the
  empty request's hash, must have been valid within 30 seconds of the grant's
  issue (at most 300 seconds long), and must verify as EIP-712 in domain
  `{name: "DaskiStandardOrder", version: "1", chainId}` with `audienceHash =
  keccak256(gatewayAudience)` for the grant's payer (see `PAYER_ACCOUNT_TYPES`
  in configuration). Nothing is consumed: the gateway already spent the
  nonce.

The task must be this provider's claim for (gateway audience, `orderId`) with
id `providerTaskId` and the grant's payer. A read is one indexed claim read,
signed afresh: no product call, write, enqueue or purchase limit. Lifecycle
failures are charged only to lifecycle's own failure bucket, and only for an
unauthenticated grant, so no buyer content can stop dispatch or status.

| Action | Answer |
| --- | --- |
| `status` | `200 {orderId, taskId, state, operations, terminalAttestation?, signature}`, never a `result` |
| `artifact`, completed | `200 {orderId, taskId, state, operations, result, terminalAttestation, signature}`; `result` is the frozen complete `ServiceResult`, whose `canonicalHash` is the attested `resultHash` |
| `artifact`, not completed | exactly `409 {"error":"artifact_unavailable"}` |
| `input`, `cancel`, `support` | exactly `409 {"error":"unsupported_action"}`, with no signature check, lookup or effect |

`state` and `operations` follow the dispatch rules above (fresh database-clock
`observedAt`). `terminalAttestation` is present only for `completed` or
`failed`: `{payload: {orderId, taskId, state, resultHash, completedAt},
signature}` by the terminal attestation key, carrying the same `taskId`,
`state`, `resultHash` and `completedAt` as the dispatch attestation forever.
`signature` is the provider authority's EIP-191 signature of the raw
`canonicalHash` of the answer without `signature` (attestation included).

| Refusal | Meaning |
| --- | --- |
| 409 `artifact_unavailable`, 409 `unsupported_action` | Named refusals: exactly one key, shown to the buyer |
| 503 `lifecycle_unavailable` | Named, retryable: database, signing or RPC failure, a frozen identity that no longer verifies, busy or rate-limited servicing |
| 400/401/403/404 `lifecycle_rejected` / `request_invalid`, `grant`, `signature`, `binding`, `authorization`, `unknown_task` | Not a valid gateway call for one of this provider's tasks; the gateway keeps it internal |

A read capability is retried as is; a payer-signed retry needs a fresh
authorization because the gateway consumed the first one.

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

A controlled failure returns `{"status": "failed", "errorCode":
"stable_product_error"}` with a code listed in the module's `failureCodes`.

Do not return pending states, access-bearing product credentials, raw upstream
responses, or unbounded artifacts. Core caps the total encoded result at 1 MB.

The listing's `resultSchema` describes this whole completed object. Before the
terminal transition, core normalizes a completed result to its stored JSON
form and validates it, as one object, against the admitted `resultSchema` of
the dispatched listing version, the response JSON budget, the artifact rules
and the gateway's passive-output rule (no `<script>`, `<form>` or other
markup tags, no `javascript:` or `data:text/html` URLs, no `on…=` handler
attributes, no control characters other than tab, line feed and carriage
return, no unsafe keys), all of which the gateway checks before it relays an
artifact; a result that fails becomes `{"status": "failed", "errorCode":
"service_result_invalid"}`. Failure evidence is exactly `{status: "failed",
errorCode}`: messages are dropped and unlisted codes become
`service_execution_failed`. Core's own codes are `service_execution_failed`,
`service_result_invalid`, `provider_execution_abandoned` (a synchronous
execution whose lease expired) and `provider_restarted_during_execution` (an
interrupted pre-R1 execution, as resolved by the cutover).

The terminal transition writes the state, the frozen result, its
`canonicalHash` (`result_hash`) and the completion time in one conditional
update, and PostgreSQL refuses any later change to them or to the claim's
bindings. Every dispatch, status and lifecycle attestation signs that frozen
hash and completion time. Rows that became terminal before the hash was frozen
keep `result_hash` NULL and are attested from their stored result exactly as
before; they are never reshaped.

## Runtime-listing coordination

The following must agree exactly:

- service and skill ids in the installed `ServiceModule`;
- closed request/result schemas, fixed atomic-USDC price, capacity, and
  deadlines in the published v2 AgentCard contract, which carries exactly the
  gateway's keys `inputSchema, resultSchema, pricing, paymentRequired,
  requiresAssetOwnership, assetType, fulfillmentMode, purchaseReadiness
  (null), capacity, deadlines, assetAction`;
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
