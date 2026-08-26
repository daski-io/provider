# Adding a service

The dummy is a complete copy-from example for one fixed-price synchronous
operation. Keep all product-specific behavior with the service that owns it.

## 1. Confirm fit

Use this starter only when the operation:

- has one reviewed fixed price in atomic USDC;
- is fully automated and needs no later input;
- completes or fails within 50 seconds;
- creates no durable buyer-owned object or later owner action; and
- can resolve external ambiguity within the same execution window.

Otherwise use [provider-full](https://github.com/daski-io/provider-full).

## 2. Copy the reference

Copy `src/services/dummy` to a lower-case, stable folder such as
`src/services/report`. Rename its exported module, adapter, constants, and
tests. Do not leave a compatibility alias for the dummy.

The module contract is `src/core/serviceRegistry/serviceModule.ts`:

```ts
interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  adapter: FulfillmentAdapter;
  readiness(signal: AbortSignal): Promise<boolean>;
  docs: { service: string; skills: Record<string, string> };
}
```

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
contract; selecting those states means selecting `provider-full`.

`readiness` is a read-only product check and must honor its signal. Return
`false` when the configured API/MCP dependency cannot accept paid work. Core
bounds the check to three seconds, caches the combined database/identity/rail/
product result briefly, and rejects paid traffic while it is false.

## 3. Define the public contract

In `manifest.ts`, choose stable service and skill ids and write descriptions
for buyer agents rather than internal staff. Each skill must declare:

- what outcome is purchased;
- required input fields and meaningful limits;
- the fixed atomic-USDC price;
- realistic turnaround within the 50-second ceiling; and
- examples that can be sent without hidden context.

Use `categoryFamily`, coordinated `serviceType`, and jurisdictions honestly.
Do not put credentials, internal endpoints, account ids, or private product
policy in a manifest or skill document.

The Daski-issued outcome request schema and the adapter validation must match.
Schema drift fails boot or dispatch rather than being tolerated.

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
product's authoritative state before retrying. Use `provider-full` if that
cannot be completed synchronously.

## 6. Validate and execute

Keep pure validation in a separate module and test boundaries explicitly.
Reject unknown fields. Count user-visible text by Unicode code points when the
contract describes characters. Revalidate in the adapter; never rely only on
gateway validation.

Map product responses to small, stable artifacts. Do not return raw upstream
responses, secrets, internal ids that grant access, or unbounded data. Core
caps the encoded service result at 1 MB, but service-specific limits should be
far smaller where practical.

Map anticipated failures to stable provider error codes. Public messages must
not reveal product internals. Unexpected exceptions are converted by core to
`service_execution_failed`.

## 7. Register the service and outcome

Replace the dummy import in `src/providerServices.ts`. Keep this as the only
installed-service list.

Update `src/providerLaunchPolicy.ts` only with the exact outcome id coordinated
with Daski. The Daski-issued `STANDARD_RAIL_OUTCOMES_JSON` must contain exactly
the same outcome set, service/skill pair, request schema, fixed price, capacity,
deadline, token, payee, and security bindings. Never hand-edit an issued
artifact to make it match code.

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
fails while `src/services/dummy` exists.

Submit the checked-in manifest, schema, docs, tests, fixed price, and operation
mapping as the technical portion of the onboarding packet. Treat later changes
to ids, schema, price, deadline, capacity, origin, payee, or behavior as a
coordinated artifact revision.
