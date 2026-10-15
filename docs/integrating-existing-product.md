# Integrating an existing API or MCP product

Most providers already have a working product. This repository is a controlled
adapter between Daski's paid-order protocol and one small, reviewed part of
that product. It should not replace or publicly proxy the product.

## First: choose the starter and mode

| Product behavior | `provider`, synchronous | `provider`, external job | `provider-full` |
| --- | --- | --- | --- |
| Fixed price known before purchase | Required | Required | Supported |
| Automated synchronous terminal response in at most 50 seconds | Required | Not needed | Supported |
| Product runs the paid work as its own job (start, lookup by order key, poll) | Not applicable | Required | Supported through its own jobs |
| Product job continues after the HTTP response | Not supported | Supported: core polls it until the product reports, past the deadline as overdue work | Supported |
| One-shot JSON/text/public artifact | Supported | Supported (the report) | Supported |
| Dynamic price depends on buyer input/product lookup | Not supported | Not supported | Supported |
| Later buyer input, approval, or cancellation | Not supported | Not supported | Supported |
| Durable private asset and owner-only actions | Not supported | Not supported | Supported |
| Human review, email, admin, or protected-data workflow | Not supported | Not supported | Supported |
| Ambiguous mutation reconciled after restart | Not supported | Supported for the job's start: core journals it and reconciles through `recoverStart` | Supported |
| Multiple active execution replicas/workers | Not supported: one active replica; restarts and short compatible overlaps are safe | Not supported: same; the worker is fenced, not a scaled platform | Supported |

Use [provider-full](https://github.com/daski-io/provider-full) if a row the
chosen mode does not support is part of the product contract. Do not simulate
a lifecycle by returning `completed` while work is still running: a product
job belongs in external-job mode, where status reads report `working` until
the report exists. Duration alone does not select `provider-full`.

External-job mode has two prerequisites the product itself must provide.
First, Daski's verified payment must be able to start an already-paid job
through a provider-owned creation operation tied to the order, never a second
purchase through a public paid endpoint. Second, after a lost start response,
the job must be found again, by an authoritative lookup on the order key or a
same-key replay inside a documented idempotency retention window. If either is
missing, onboarding stops at that upstream gap; `provider-full` cannot supply
it.

## Vocabulary

- **Provider**: your organization and the Daski-facing runtime/identity.
- **Supplier**: the upstream API, MCP server, or product, even if your
  organization owns it.
- **Service**: one coherent product boundary visible in discovery.
- **Skill**: one buyer-visible fixed operation.
- **Outcome**: the reviewed Daski listing/payment coordinate for a skill.

One product may map to several skills, but each skill must map to one fixed
operation. Avoid a generic `call-api` or `call-tool` skill.

## Complete this mapping worksheet

Record the answers in the service's tracked docs and tests:

| Question | Required answer |
| --- | --- |
| Buyer outcome | What is finished when the adapter returns `completed`? |
| Fixed price | Exact positive atomic USDC amount (USDC has 6 decimals) |
| Input | Field names, types, required/optional status, bounds, and conditional rules |
| Product operation | One configured API endpoint/method or MCP server/tool |
| Authentication | Provider-held credential source; never buyer supplied |
| Execution bound | Synchronous: product timeout safely below 50 seconds. External job: normal and maximum runtime, per-call budget, declared fulfillment window |
| Payment mapping | External job: how the verified Daski order starts an already-paid product job |
| Idempotency | Stable product key derived from verified task/order context; for a job, the product's documented replay retention |
| Ambiguity | Synchronous: an authoritative read within the call. External job: lookup by order key after timeout, crash or key expiry |
| Job | External job: stable reference, exact product states, poll limits and rate limits, report retention |
| Output | Small stable artifact schema and safe public message |
| Failure | Stable error codes and what is definitive versus ambiguous |
| Readiness | What proves the product dependency can accept work |
| Environments | Separate fake/sandbox/Testnet/live credentials and side effects |

If there is no authoritative ambiguity check for a mutating operation, the
fit test fails even when the normal response is fast. The gateway does not
keep the report for you: an external job's result is frozen in this
provider's database when it completes, and a report larger than the result
schema allows needs a durable delivery the product keeps.

## API integration pattern

Keep configuration, client, validation, and adapter separate:

```text
src/services/report/
  adapter.ts
  client.ts
  config.ts
  manifest.ts
  validation.ts
  docs/
  tests/
```

Pin the configured base URL to one reviewed origin/base path and append only a
constant operation path:

```ts
import { boundedFetch } from "../../core/security/outboundHttp.js";
import {
  appendReviewedOperation,
  reviewedEndpoint,
} from "../../core/security/reviewedEndpoint.js";

const REVIEWED_BASE = "https://api.example.com/v1";

export async function createReport(
  configuredBase: string,
  token: string,
  request: { topic: string },
  signal: AbortSignal,
): Promise<{ reportId: string; summary: string }> {
  const base = reviewedEndpoint(configuredBase, REVIEWED_BASE);
  const url = appendReviewedOperation(base, "reports");
  const response = await boundedFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  }, {
    timeoutMs: 20_000,
    maxResponseBytes: 64_000,
    allowedContentTypes: ["application/json"],
    publicTarget: {},
  });
  if (!response.ok) throw new Error("product request failed");
  return parseProductResponse(response.json());
}
```

The parser must validate exact response shape, type, and bounds. Do not include
raw response text in an exception. For a private network product, add a
deliberately reviewed private-target client rather than disabling the public
SSRF checks globally.

The adapter passes `context.signal` as `init.signal` and uses a product
timeout comfortably below the core deadline. `boundedFetch` composes the two:
either one ends the request, the response-body read included, on the plain
and the IP-pinned path alike. An abort only stops waiting; it never proves
the product did not apply the request, so a mutating call reconciles through
its idempotency key rather than retrying. Do not rely on core's outer limit
(the 50-second synchronous budget, or one external-job call's limit) to clean
up an unbounded socket or SDK call.

### API rules

- Fixed origin and base path from provider configuration.
- Fixed method and relative path in code.
- Provider credential injected at runtime.
- No redirects unless a specific safe redirect policy is implemented and
  tested.
- Explicit content type, timeout, response-size, and concurrency bounds.
- Strict request and response schemas.
- Stable idempotency header/key for every mutation.
- No raw product payloads in logs, errors, or terminal artifacts.

## MCP integration pattern

The provider is the MCP client; the buyer does not directly control that
client. Add the product's supported MCP SDK to your fork and wrap it behind a
small service-local client:

```ts
const TOOL_BY_SKILL = {
  summarize: "create_summary",
} as const;

async function runReviewedTool(
  skillId: keyof typeof TOOL_BY_SKILL,
  input: { text: string },
  signal: AbortSignal,
) {
  const tool = TOOL_BY_SKILL[skillId];
  return mcpClient.callTool(
    { name: tool, arguments: { text: input.text } },
    { signal, timeout: 20_000 },
  );
}
```

Adapt the exact call signature to the SDK you select, but preserve the
boundary:

- the server and transport are fixed in provider configuration;
- tool names are an exhaustive code mapping, not buyer strings;
- tool arguments are reconstructed from validated fields;
- discovery cannot silently add buyer-visible operations;
- output is schema-checked and size-bounded;
- auth, stderr, server logs, and protocol metadata never become artifacts; and
- cancellation/timeout is connected to `context.signal`.

For remote MCP, apply the same reviewed HTTPS origin and SSRF rules as an API.
For a local stdio server, pin the executable/arguments at deployment and do not
construct shell commands from buyer input. If the MCP tool starts an async job
that can be found again by an order key and polled, use external-job mode; if
it requires sampling/elicitation later, use `provider-full`.

## Adapter responsibilities

The adapter receives verified context only after rail admission:

```ts
{
  taskId, orderId, payer, serviceSlug, skillId, signal
}
```

It must:

1. reject an unexpected skill id;
2. parse the request again with service-owned validation;
3. stop promptly when `signal` is aborted;
4. call exactly one reviewed product operation;
5. map a known product response to a small terminal result; and
6. map known definitive errors to stable safe error codes.

It must not verify payment, accept caller identity from input, modify global
rail state, leak product details, return a non-terminal state, or continue work
after returning.

An external-job adapter (`mode: "external-job"`) is called by the worker
instead, never by the dispatch handler, with an `ExternalJobContext` that adds
core's stable `idempotencyKey`, the persisted `acceptedAt`,
`fulfillmentDeadline`, `firstStartAttemptAt` and `idempotencyValidBefore`,
and a per-call `signal`:

- `start` submits the job under `idempotencyKey` and returns `accepted` (a
  bounded job reference of at most 16 KiB, never a credential bundle or the
  upstream body), `terminal`, or `ambiguous`; any throw, abort or invalid
  return counts as ambiguous;
- `recoverStart` is read-only: it returns the original job or result, a
  `safe-to-start` verdict on `authoritative-absence` or `idempotent-replay`
  basis, or `unknown`; an empty eventually consistent search is `unknown`;
- `poll` is read-only: `pending`, `terminal`, or `retry` with a typed issue.

Only core schedules a start, and only core's reviewed codes and hints leave
the adapter. Copy `src/services/synthetic-audit` for the full pattern.

Implement `ServiceModule.readiness(signal)` as a bounded, read-only product
probe. It must return false (without leaking the cause) when the configured
API/MCP dependency cannot accept work and honor the three-second abort signal.
Core uses this result both for `/health/ready` and paid-route admission.

## Idempotency and ambiguous mutations

Read-only and naturally convergent operations are simplest. For a mutation,
send a stable upstream idempotency key such as a versioned hash/encoding of the
verified `orderId`, service, skill, and operation kind.

Use `runSupplierOperation` when the mutation needs a local intent journal. It
persists intent before execution, returns an already confirmed result on
replay, and invokes `reconcile` for a dangling/ambiguous attempt. The
reconciliation function must read authoritative product state and return:

- the confirmed result when the operation happened;
- `null` only when it definitively did not happen and is safe to execute; or
- `SupplierOutcomeAmbiguousError` when neither can be proven.

In the synchronous mode an unresolved ambiguous result becomes a terminal
failure; there is no background reconciliation for a synchronous call.
Therefore use the journal there only when the product can resolve within the
synchronous deadline. An external-job adapter never journals its own start:
core journals it and reconciles it through `recoverStart`
(`docs/architecture.md`).

## Output and data boundary

Prefer small JSON/text results. A URL artifact must be public and
non-sensitive; do not return bearer-token URLs or treat an unprotected URL as
ownership. A bearer report URL a product hands back for a job may be kept in
the job reference, which core stores encrypted and never logs, but it is not
a recovery method on its own: if the start response carrying it is lost, the
job must still be found by the order key. If results are private, retained, re-downloadable, mutable, or need
owner-only operations, model them as assets in `provider-full`.

This starter does not persist request bodies, but your product still receives
them. Minimize data, document retention in provider terms/privacy, and never
send protected data to an upstream dependency that was not reviewed for it.

## Testing the integration

Use a fake client and cover:

1. every field boundary and unknown field;
2. exact skill-to-operation mapping;
3. no buyer-controlled endpoint/tool/credential path;
4. timeout and abort behavior;
5. response type/size failures;
6. safe error and log redaction;
7. duplicate execution/idempotency;
8. definitive failure versus ambiguous result;
9. authoritative reconciliation, if mutating;
10. completed and failed terminal artifacts; and
11. for an external job: a lost start response recovered without a second
    job, an idempotency horizon that has expired, a terminal report that
    fails the result schema, a late completion after the deadline, and the
    exact mapping of every product state.

Then run one deliberately bounded Testnet journey through the real Daski
gateway and the product sandbox. Record only safe evidence: commit/image
digest, check codes, public chain coordinates, non-sensitive request ids, and
redacted results.
