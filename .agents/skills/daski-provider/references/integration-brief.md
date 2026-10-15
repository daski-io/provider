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

## How to collect the facts

Research the product's safe documentation, SDK reference, and schemas first.
Ask the user only for facts those sources do not answer, and say why each
one changes the path or the implementation. While live integration facts are
missing, continue independent local work against a fake client and keep the
gaps listed in the brief. Never invent a paid endpoint's idempotency
contract, treat a lost response as a definitive refusal, or test either
assumption by spending without authorization.

## Required operation mapping

Record this for every proposed skill:

| Field | Required decision |
| --- | --- |
| Buyer outcome | What is definitively complete when fulfillment finishes? |
| Input | Closed fields, types, required/optional status, bounds, and conditional rules |
| Result | Bounded schema of the complete completed result, permitted artifact delivery, and stable public failures |
| Price | Fixed atomic USDC or bounded dynamic quote; identify every input to pricing |
| Product operation | One fixed API method/path, MCP server/transport/tool, SDK method, or internal command, with its service-owned authentication and endpoint configuration |
| Payment mapping | Whether Daski's verified payment starts an already-paid provider-owned job, or a separately funded upstream purchase would be required (then onboarding is incomplete) |
| Timing | Normal and maximum runtime, per-call budget, declared fulfillment duration, and capacity |
| Idempotency | Stable key derived from verified order/task context; the product's guarantee, its minimum key-retention window, and the replay margin kept before it ends |
| Recovery | Authoritative lookup that finds the original job or proves it never started, after a timeout, crash, or key expiry |
| Job | Stable job reference, exact product states, poll scheduling and rate limits, and overdue handling |
| Report | Where the report lives and how long the product keeps it; the gateway does not retain it for the provider |
| Side effects | Records, charges, messages, filings, purchases, or other external mutations |
| Later workflow | Required buyer input, cancellation, protected data, assets, operator intervention, and the deployment model |
| Data | Fields sent upstream, sensitivity, retention, redaction, and support evidence |
| Readiness | Bounded read-only signal proving the product can accept work; per-request checks that run before a quote |
| Environments | Fake, sandbox, Testnet, and live separation plus possible Testnet cost |
| Operations | Concurrency, rate limits, outage behavior, and support owner |

For a synchronous skill the job, recovery-after-crash, and report rows may be
"not applicable", but its ambiguity must still resolve within the call. If a
missing answer changes the path, payment, ownership, execution, or data risk,
stop and obtain it. Otherwise make a conservative local assumption, label it,
and keep it easy to revise.

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
integration technique. A URL a product returns (a job or report location) is
validated against the reviewed origin and path before the service follows it.

## MCP boundary

The provider is the MCP client. Pin the server, transport, executable, and
arguments in provider configuration. Map each Daski skill id through an
exhaustive code mapping to one tool name, rebuild tool arguments from validated
fields, and validate bounded output. Connect cancellation and timeout to the
provider task signal.

Do not pass through buyer-selected server URLs, transports, tool names,
schemas, environment variables, shell fragments, or protocol metadata. Do not
let MCP discovery silently create marketplace operations. A tool that launches
a job which can be found again by an order key and polled fits lite
external-job mode; one that needs later elicitation or sampling requires
`provider-full`.

## Mutation and ownership decision

For every mutation, distinguish:

- naturally idempotent or convergent operations;
- non-convergent operations with a product idempotency key;
- ambiguous operations with an authoritative reconciliation read; and
- operations whose ambiguity can outlive the current process or request.

Lite synchronous mode permits only the first three, and only when
reconciliation finishes inside its synchronous call. A product job whose
start may outlive the call fits lite external-job mode: core journals the
start under a stable key and reconciles it through the adapter's read-only
`recoverStart` after any restart. Provider-owned multi-step workflows with
their own durable state require `provider-full`. If no lookup or replay
guarantee exists, no starter can make the start safe; record the gap.

Durable private results, re-downloadable objects, mutable resources, and
owner-only operations are assets in `provider-full`. Ownership comes from the
verified wallet-authorized payer, never an input wallet, order id, asset id, or
caller metadata.

## Implementation brief template

Produce a safe brief before code:

```markdown
Path: lite synchronous | lite external job | provider-full
Facts supporting the path:
Checkout revision and capability check:
Service: <slug and buyer-visible purpose>

Skill: <id>
- Completed outcome and complete result schema:
- Closed input bounds:
- Price behavior:
- Fixed product operation and its authentication/endpoint configuration:
- Payment mapping (already-paid start or upstream gap):
- Runtime (normal, maximum), per-call budget, fulfillment window, capacity:
- Idempotency guarantee, key retention, replay margin:
- Recovery lookup after timeout, crash, or key expiry:
- Job reference, product states, polling and rate limits, overdue handling:
- Report location and retention:
- Side effects and Testnet cost:
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
applicable, and terminal artifact bounds. An external job adds a lost start
response, an expired idempotency horizon, an invalid terminal report, a late
completion, and the exact upstream-state mapping
([External jobs](external-jobs.md)). Unit tests use fake clients; live
product and paid Testnet journeys are separate explicitly authorized stages.
