# Adding a service

The dummy is a complete copy-from example for one fixed-price synchronous
operation; `src/services/synthetic-audit` is the copy-from example for an
external job. Keep all product-specific behavior with the service that owns
it.

## 1. Confirm fit

Use this starter only when the operation:

- has one reviewed fixed price in atomic USDC;
- is fully automated and needs no later input;
- creates no durable buyer-owned object or later owner action; and
- either completes or fails within the 50-second synchronous budget and
  resolves external ambiguity within that call (synchronous mode), or is a
  job the product already runs, which core can start under a stable key,
  find again by it after a lost response and poll until its report
  (external-job mode; see "Adding an external-job service" at the end).

Otherwise use [provider-full](https://github.com/daski-io/provider-full).
Duration alone does not decide; a product that cannot reconcile a lost start
is an upstream gap in either starter.

## 2. Copy the reference

Copy `src/services/dummy` to a lower-case, stable folder such as
`src/services/report`. Rename its exported module, adapter, constants, and
tests. Do not leave a compatibility alias for the dummy.

The module contract is `src/core/serviceRegistry/serviceModule.ts`:

```ts
interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  adapter: ServiceAdapter; // FulfillmentAdapter | ExternalJobAdapter
  previousExternalJobAdapters?: Readonly<Record<string, ExternalJobAdapter>>;
  readiness(signal: AbortSignal): Promise<boolean>;
  requestReadiness?(context: RequestReadinessContext): Promise<RequestReadiness>;
  failureCodes?: readonly string[];
  docs: { service: string; skills: Record<string, string> };
}
```

An adapter without a `mode` (or with `mode: "sync"`) is synchronous, as the
dummy's is; this guide describes that mode. For an external job, copy
`src/services/synthetic-audit` instead: a Testnet-only example with an
in-memory fake product that `src/providerServices.ts` does not compose
(`npm run try-skill -- synthetic-audit audit` tours it offline). An `ExternalJobAdapter`
(`mode: "external-job"`, with `version`, `start`, `recoverStart` and `poll`)
is for a product that already runs the paid work as its own asynchronous
job; its types are in `src/core/serviceRegistry/adapterTypes.ts`. The mode
belongs to the whole service. Registration validates both: a job adapter's
version (1 to 64 letters, digits, `.`, `_`, `-`), its optional
`idempotencyRetentionSeconds`, retained previous versions keyed by exactly
their own version, and an explicit `deadlines.fulfillmentSeconds` of at least
`dispatchSeconds + 180` on every skill. While async admission is active
(`docs/configuration.md`), a funded external-job dispatch is admitted as one
queued job and answered `submitted` (or a later state the worker already
persisted); the dispatch handler never calls the product, and product
readiness is not consulted for it (the job waits for the product instead).
New external-job quotes need the switch on, an active encryption key and a
running worker in the process; otherwise they answer `503 quote_unavailable`
(`external_jobs_unavailable`). The worker then calls the adapter as
`docs/architecture.md` describes.

An order is run by the adapter version that sold it. Each quote records the
external-job adapter version selling it, a funded dispatch is admitted under
exactly that version (the current adapter or a retained one) even when it
arrives after new sales moved to another version or listing version, and its
job is always resumed by it, while the result is held to the contract of the
listing version the order was paid under. When a new version changes how job
references are read, or maps reports to a new listing version's result
contract, give it a new `version` and keep the old adapter in
`previousExternalJobAdapters` (keyed by its own version) until its jobs
finish, the quotes it sold can no longer be dispatched (their window, the
version's fulfillment window and 30 days) and no older instance still sells
it. A dispatch whose selling version this build lacks is refused before
admission (`outcome_policy`), and boot, the importer and activation refuse a
build that dropped a version an unfinished job or such a quote needs or, while
async admission is on, one a running instance still sells. A mapper fix that
keeps the reference format and the result contract keeps its version. A quote
that recorded no version (a synchronous adapter sold it, or it was issued
before migration 010) is admitted under the service's current adapter, as
every order was before versions were recorded.

The mode is a property of the installed service, not of its listing
versions: an order sold by a synchronous adapter records no version and runs
in the service's current mode. Never switch an installed service between
synchronous and external-job while orders of its earlier versions may still
be dispatched; publish the other mode as a new service instead.

The adapter contract is intentionally terminal:

```ts
execute(
  context: TaskContext,
  input: Record<string, unknown>,
): Promise<
  | { status: "completed"; message?: string; artifacts?: ServiceArtifact[] }
  | { status: "failed"; errorCode: string; message?: string }
>
```

Honor `context.signal`. Do not add pending/working/input-required states to this
contract: a product job that stays pending belongs in external-job mode, and
later buyer input means `provider-full`.

`readiness` is a read-only product check and must honor its signal. Return
`false` when the configured API/MCP dependency cannot accept paid work. Core
bounds the check to three seconds, caches the combined database/identity/rail/
product result briefly, and stops new quotes and new dispatches while it is
false; already-admitted orders stay readable.

The optional `requestReadiness` hook checks one schema-valid request before
each new quote. It receives `{skillId, input, payer, signal}` (`payer` is the
lowercase quote payer or `null`) and returns `{ready: true}` or `{ready:
false, fieldErrors: [{path, rule, message, allowedValues?}]}` with reviewed
messages. Decline an unbound `null` payer if the product needs to know who
pays. It must stay read-only: it cannot change the fixed price and must never
start work, reserve capacity, or purchase anything. A throw, a timeout after
three seconds, or any other result shape stops the quote without a refusal
reason reaching the buyer. Funded dispatches never re-run it.

## 3. Define the public contract

In `manifest.ts`, choose stable service and skill ids and write descriptions
for buyer agents rather than internal staff. Each skill must declare:

- what outcome is purchased;
- required input fields and meaningful limits;
- the fixed atomic-USDC price;
- realistic turnaround: within the 50-second synchronous budget, or for an
  external job the product's normal runtime under a declared
  `deadlines.fulfillmentSeconds` that covers runtime, queueing, retries and
  report retrieval; and
- examples that can be sent without hidden context.

Use `categoryFamily`, coordinated `serviceType`, and jurisdictions honestly.
Do not put credentials, internal endpoints, account ids, or private product
policy in a manifest or skill document.

Marketplace search matches exact words in service/skill names, descriptions,
and skill tags; examples and schemas are not searched. Include truthful common
product names and synonyms a buyer will type, without advertising inputs or
outcomes the schema cannot support. Presentation copy is outside the hashed
skill contract, so a copy-only correction does not require a new runtime
listing.

The manifest's closed input/result schemas become the published skill contract.
The adapter validation must match them. Contract drift changes the
`skillContractHash` and requires a newly reviewed runtime bundle; it is never
silently tolerated.

`resultSchema` describes the complete completed `ServiceResult` the adapter
returns, `{status: "completed", message?, artifacts?}`, not only the data of
one artifact: the buyer's artifact read returns that whole object, and the
gateway validates it against the schema frozen in the order. Pin `status` with
`schema.stringEnum(["completed"])` and describe every artifact field the
adapter emits; never add a field the adapter does not produce. Failures are
not described by the schema.

Core publishes every contract with the gateway's full key set, including
`purchaseReadiness: null` (lite never gates purchases on payer DNS), and
always publishes both deadlines. The defaults are `{dispatchSeconds: 300,
fulfillmentSeconds: 900}`. Registration refuses a synchronous skill whose
`fulfillmentSeconds` is below `dispatchSeconds + 230`: when an initial
dispatch is lost, the gateway may replace it only after the envelope's
`validBefore` (`dispatchSeconds`) plus 60 seconds, the replacement then runs
for up to the 50-second synchronous budget, and core keeps a reviewed
120-second margin for gateway retry backoff, status polling, transport
timeouts and clock tolerance. The gateway stops re-dispatching a paid order
once `fulfillmentSeconds` have passed since it observed the release, so a
shorter window makes a lost dispatch unrecoverable.

## 4. Parse service configuration

Add `src/services/<slug>/config.ts` for product variables. Parse them strictly;
do not read scattered `process.env` values throughout the adapter. Separate
Testnet/sandbox credentials from Mainnet and refuse any sandbox or mock mode on
Base Mainnet.

Never commit a token. Add only variable names and safe placeholders to
`.env.example`, and document ownership and secrecy in `docs/configuration.md`.

## 5. Build a fixed product client

Create one named method for each reviewed operation. The buyer may select a
skill and provide validated business input, but cannot select:

- a URL, hostname, port, or redirect target;
- an HTTP method, arbitrary path, or headers;
- an MCP server, transport, tool name, or tool schema; or
- provider/product credentials.

For HTTPS, use core's bounded and reviewed endpoint utilities. For MCP, create
the transport from provider configuration and expose only hard-coded tool calls
through your client. Apply timeouts, response-size bounds, concurrency limits,
strict response parsing, and redacted errors.

If a product mutation is non-convergent, use the supplier operation journal
with a stable key derived from the verified order/task—not from mutable buyer
text. Prefer an upstream idempotency key. After timeout or disconnect, query the
product's authoritative state before retrying. If that cannot be completed
within the synchronous call, the operation is an external job (core journals
its start) or needs `provider-full`; never retry it blindly.

## 6. Validate and execute

Keep pure validation in a separate module and test boundaries explicitly.
Reject unknown fields. Count user-visible text by Unicode code points when the
contract describes characters. Revalidate in the adapter; never rely only on
gateway validation.

Map product responses to small, stable artifacts. Do not return raw upstream
responses, secrets, internal ids that grant access, or unbounded data. Core
caps the encoded service result at 1 MB, but service-specific limits should be
far smaller where practical.

Map anticipated failures to stable provider error codes and list every code
the adapter may return in the module's `failureCodes` (lowercase, `a-z`, `0-9`
and `_`). Core attests a failure as exactly `{status: "failed", errorCode}`:
the adapter's `message` is dropped, and an unlisted code becomes
`service_execution_failed`, so failure evidence never carries free text.
Unexpected exceptions and timeouts are also converted to
`service_execution_failed`. The list is the service's, not one adapter
version's: every installed version, retained previous external-job adapters
included, is judged against it. When a new version changes its codes, keep
each code a retained version can still return until that version is
removed.

Before freezing a completed result, core holds the whole object to the
artifact rules above, the response JSON budget, the gateway's passive-output
rule and the listing version's admitted `resultSchema`. A result that fails
becomes the terminal failure `service_result_invalid` (a synchronous task has
no later retrieval) and logs `Synchronous result failed its admitted result
contract` with a stable `diagnostic` and schema keywords, never the result
itself. Test the adapter output against the published schema, as the dummy's
co-located tests do.

The passive-output rule is the gateway's own check before it relays any
artifact: no markup tags such as `<script>` or `<form>`, no `javascript:` or
`data:text/html` URLs, no `on…=` handler attributes, no control characters
other than tab, line feed and carriage return, no `__proto__`-style keys.
If buyer input flows into the result, decline input that would break it
before payment: core exports `isPassiveText` and `isPassiveOutput` from
`serviceRegistry/types.ts`, and the dummy's `requestReadiness` hook uses them
so an echo of `<form>` is refused at quote time instead of becoming a paid
failure.

## 7. Compose and onboard the service

Replace the dummy import in `src/providerServices.ts`. Keep this as the only
installed-service list.

Paid skills are derived from the installed manifests; there is no second
hand-maintained outcome allowlist. Give Daski the deployed AgentCard and the
review packet described in `docs/onboarding.md`. Daski supplies one runtime
bundle for each service and matching global policy configuration.

After copying those values into the deployment secret manager, install the
bundle from a protected local path:

```bash
npm run daski:install-runtime -- --file /secure/path/runtime-bundle.json
```

The command does not accept partial or hand-edited listings. It requires the
exact installed paid-skill set for that service and verifies the local contract
hash, fixed price, provider intent, gateway signatures, runtime commitment, and
splitter provenance before writing. A service-contract or price change needs a
new bundle; never edit the catalog or an issued file.

## 8. Co-locate service evidence

Keep these in `src/services/<slug>/`:

```text
adapter.ts
client.ts                 # when the product has an API/MCP dependency
config.ts
docs/index.md
docs/<skill>.md
index.ts
manifest.ts
tests/<service>.test.ts
tests/validation.test.ts
validation.ts
```

Tests should cover exact boundaries, unknown fields, Unicode/byte limits,
skill mismatch, abort/timeout, safe product-error mapping, idempotency and
ambiguity when mutations exist, artifact bounds, and both terminal states.
Use a fake product client; unit tests must never call a live API/MCP server.

## 9. Verify and remove dummy

Run the gates in `README.md`, then search the release diff for `dummy`, test
credentials, product account data, and raw captured output. The Mainnet doctor
fails while `src/services/dummy` exists or the synthetic audit is composed.

Submit the checked-in manifest, schemas, docs, tests, fixed price, and operation
mapping as the technical portion of the onboarding packet. Treat later changes
to ids, schema, price, deadline, capacity, origin, payee, or behavior as a
coordinated contract and runtime-bundle revision.

## Adding an external-job service

Copy `src/services/synthetic-audit` when the product already runs each paid
operation as its own asynchronous job. The runtime supplies persistence,
the stable operation key, leases, polling, restart recovery, resumption of
each job by the adapter version that admitted it, encrypted job state and
signed status and artifact reads; the service supplies:

1. a manifest and skills with closed input schemas, a fixed price and an
   explicit `deadlines.fulfillmentSeconds` (at least `dispatchSeconds + 180`)
   covering the product's maximum runtime, queueing, retries and report
   retrieval;
2. strict input validation, repeated in the adapter, and a `resultSchema`
   describing the complete completed `ServiceResult` the report maps to;
3. strictly parsed configuration and a fixed product client on the reviewed
   outbound helpers;
4. the adapter: `mode: "external-job"`, a `version`, the product's documented
   `idempotencyRetentionSeconds` when it has one, and `start`, read-only
   `recoverStart` and read-only `poll` returning only the typed outcomes in
   `src/core/serviceRegistry/adapterTypes.ts`;
5. an optional read-only `requestReadiness` that declines unacceptable
   requests before payment (a later product outage delays the admitted job;
   it never refuses a funded one), the bounded `readiness` probe, and the
   reviewed `failureCodes`;
6. previous adapters in `previousExternalJobAdapters` while jobs they admitted
   are unfinished or quotes they sold may still be dispatched (a new `version`
   whenever the reference format or the result contract it maps to changes),
   with their failure codes kept in `failureCodes`; and
7. docs and co-located tests with a fake product.

Map every product state exactly: a pending job is `pending` (it never spends
the failure budget), a definitive product failure is `terminal` with a
reviewed failure code, and anything uncertain is `ambiguous`, `unknown` or
`retry`. The fulfillment deadline is an overdue threshold, not proof that
the product failed: started work stays `working` and a late valid report
still completes once. A terminal report that fails the result schema leaves
the job `working` and stops new quotes for that mapping until a repaired
mapper recovers it. Never build a private polling loop, hold a request open
for the job, raise the synchronous budget, or copy provider-full's operator or
asset subsystems.

Test at least: a lost start response recovered by the order key without a
second job, a same-key replay refused once the retention horizon has passed,
an invalid terminal report, a late completion after the deadline, the exact
upstream-state mapping, and a restart in each phase. Before Testnet, set
`PROVIDER_DATA_ENCRYPTION_KEY` and plan the activation described in
`docs/onboarding.md`.
