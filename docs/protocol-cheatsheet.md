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

## Paid order

This starter implements fixed listing quotes only. Daski signs `QuoteV1` from
the reviewed fixed offer; there is no provider quote callback.

The gateway sends `/standard-rail/dispatch` with exactly:

```text
dispatch       SignedEnvelope<StandardRailDispatchV2>
quote          SignedEnvelope<QuoteV1>
request        object matching the reviewed JSON Schema
evidenceBundle StandardEvidenceBundleV2 (deposit + release)
```

Core verifies the gateway signature and every domain/payment/request binding.
On success it returns a provider-signed terminal response whose state is
`completed` or `failed`. Calls that fail admission receive a generic error and
never invoke the service.

The gateway can query `/standard-rail/dispatch/status` with a signed
`DispatchStatusQueryV1`. The query is bound to the original order and dispatch
hash. A changed replay is rejected.

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
