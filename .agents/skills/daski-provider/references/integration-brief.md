# Build the API or MCP integration brief

Read this reference before implementing a service or when deciding whether an
existing product fits Daski. The output is a compact engineering brief, not a
second private product specification.

## Vocabulary

- **Provider:** the organization, runtime, identity, and provider wallet that
  face Daski.
- **Supplier:** the upstream API, MCP server, SDK, or internal product, even
  when the provider owns it.
- **Service:** one coherent product boundary published through discovery.
- **Skill:** one buyer-visible operation with a closed contract.
- **Outcome/runtime listing:** the reviewed Daski listing and payment
  coordinate for a paid skill.

Do not create a generic `call-api`, `call-tool`, or arbitrary proxy skill. One
skill maps to one reviewed product operation. A product may expose several
focused skills when their contracts and outcomes are genuinely distinct.

## Required operation mapping

Record this for every proposed skill:

| Field | Required decision |
| --- | --- |
| Buyer outcome | What is definitively complete when fulfillment returns? |
| Input | Closed fields, types, required/optional status, bounds, and conditional rules |
| Result | Bounded terminal schema, artifacts, and stable public failures |
| Price | Fixed atomic USDC or bounded dynamic quote; identify every input to pricing |
| Product operation | One fixed API method/path, MCP server/transport/tool, SDK method, or internal command |
| Authentication | Provider-held credential source and environment; never buyer supplied |
| Timing | Product timeout, total fulfillment deadline, cancellation, and later work |
| Idempotency | Stable key derived from verified order/task context |
| Ambiguity | Authoritative read/reconciliation that proves happened or did not happen |
| Side effects | Records, charges, messages, filings, purchases, or other external mutations |
| Data | Fields sent upstream, sensitivity, retention, redaction, and support evidence |
| Readiness | Bounded read-only signal proving the product can accept work |
| Environments | Fake, sandbox, Testnet, and live separation plus possible Testnet cost |
| Operations | Capacity, concurrency, rate limits, outage behavior, and support owner |

If a missing answer changes starter selection, payment, ownership, execution,
or data risk, stop and obtain it. Otherwise make a conservative local
assumption, label it, and keep it easy to revise.

## API boundary

The service client must pin a reviewed origin and base path and expose named
methods with constant relative paths and HTTP methods. Reconstruct the request
from validated buyer fields. Use repository-provided outbound controls for
SSRF protection, redirects, timeouts, response bytes, content types, and
concurrency. Strictly parse responses and convert failures to bounded, stable
public codes without logging raw payloads.

Never allow buyer input to choose a hostname, port, method, path, redirect,
header, credential, or product account. Private-network targets require a
deliberate reviewed boundary; disabling SSRF checks globally is not an
integration technique.

## MCP boundary

The provider is the MCP client. Pin the server, transport, executable, and
arguments in provider configuration. Map each Daski skill id through an
exhaustive code mapping to one tool name, rebuild tool arguments from validated
fields, and validate bounded output. Connect cancellation and timeout to the
provider task signal.

Do not pass through buyer-selected server URLs, transports, tool names,
schemas, environment variables, shell fragments, or protocol metadata. Do not
let MCP discovery silently create marketplace operations. A tool that launches
a job, needs later elicitation/sampling, or outlives the dispatch requires
`provider-full`.

## Mutation and ownership decision

For every mutation, distinguish:

- naturally idempotent or convergent operations;
- non-convergent operations with a product idempotency key;
- ambiguous operations with an authoritative reconciliation read; and
- operations whose ambiguity can survive the current process/request.

The minimal starter permits only the first three when reconciliation can finish
inside its synchronous execution window. Anything that must resume, retry, or
reconcile after restart requires the full starter and durable workers/journals.

Durable private results, re-downloadable objects, mutable resources, and
owner-only operations are assets in `provider-full`. Ownership comes from the
verified wallet-authorized payer, never an input wallet, order id, asset id, or
caller metadata.

## Implementation brief template

Produce a safe brief before code:

```markdown
Starter: provider | provider-full
Service: <slug and buyer-visible purpose>

Skill: <id>
- Completed outcome:
- Closed input/result bounds:
- Price behavior:
- Fixed product operation:
- Authentication owner/environment:
- Timeout/cancellation:
- Side effects and Testnet cost:
- Idempotency and ambiguity reconciliation:
- Data sent/retained/redacted:
- Readiness and outage behavior:
- Tests required:

Missing provider inputs:
Missing product inputs:
Missing Daski inputs:
Assumptions requiring review:
```

Keep secret values and raw production material out of the brief. Store durable
technical decisions in the service's tracked docs and tests after checkout.

## Minimum adversarial tests

Cover field limits and unknown fields, exact skill-to-operation mapping,
buyer-controlled endpoint/tool/credential rejection, timeout and abort,
response shape and size, public error redaction, duplicate execution,
definitive versus ambiguous failure, mutation reconciliation, ownership when
applicable, and terminal artifact bounds. Unit tests use fake clients; live
product and paid Testnet journeys are separate explicitly authorized stages.
