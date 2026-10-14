import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), openObligations: 0 }));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: db.query } }));

import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { StandardQuoteService, FIXED_QUOTE_LIFETIME_SECONDS } from "../src/core/standardRail/quote.js";
import { QuoteRefusal, QuoteUnavailable } from "../src/core/standardRail/quoteErrors.js";
import { clearSalesStopsForTests, stopNewSales } from "../src/core/standardRail/salesStops.js";
import {
  acceptIntakeAsGateway,
  acceptQuoteAsGateway,
  gatewayIntakeRequest,
  gatewayQuoteFieldErrors,
  gatewayQuoteRequest,
  nowSeconds,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import { echoService, gatewayListing, railConfig, railOutcome } from "./standardRailServiceFixture.js";

const payer = `0x${"ab".repeat(20)}` as Hex;
const listing = gatewayListing();
const request = { message: "hello" };
const quotes = () => new StandardQuoteService(railConfig(), 84532);
const insertedQuotes = () => db.query.mock.calls
  .filter(([sql]) => String(sql).includes("INSERT INTO provider_quotes"));

async function refusal(work: Promise<unknown>): Promise<QuoteRefusal | QuoteUnavailable> {
  const error = await work.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof QuoteRefusal) && !(error instanceof QuoteUnavailable)) {
    throw new Error(`expected a reviewed quote refusal, got ${String(error)}`);
  }
  return error;
}

beforeEach(() => {
  db.openObligations = 0;
  db.query.mockReset().mockImplementation(async (sql: string) => String(sql).includes("count(*)")
    ? { rows: [{ count: String(db.openObligations) }] }
    : { rows: [], rowCount: 1 });
  clearServicesForTests();
  registerService(echoService());
});

afterEach(() => {
  clearServicesForTests();
  clearSalesStopsForTests();
  vi.useRealTimers();
});

describe("signed fixed readiness quote", () => {
  it("issues a payer-bound fixed quote that the gateway verifies and persists it first", async () => {
    const envelope = await gatewayQuoteRequest({ listing, request, payer });
    const body = await quotes().quote(envelope);
    const accepted = await acceptQuoteAsGateway({ listing, body, request, payer });
    expect(accepted.grossAmount).toBe("10000");
    expect(accepted.validBefore - accepted.issuedAt).toBe(FIXED_QUOTE_LIFETIME_SECONDS);
    const [[, params]] = insertedQuotes() as unknown as [[string, unknown[]]];
    expect(`0x${(params[0] as Buffer).toString("hex")}`).toBe(accepted.providerQuoteHash);
    expect(params.slice(4, 8)).toEqual(["10000", payer, accepted.issuedAt, accepted.validBefore]);
  });

  it("echoes a null payer literally and binds it as unbound", async () => {
    const body = await quotes().quote(await gatewayQuoteRequest({ listing, request, payer: null }));
    expect((body as { payer: unknown }).payer).toBeNull();
    await expect(acceptQuoteAsGateway({ listing, body, request, payer: null })).resolves.toBeDefined();
    await expect(acceptQuoteAsGateway({ listing, body, request, payer }))
      .rejects.toThrow("PROVIDER_QUOTE_UNAVAILABLE");
  });

  it("refuses malformed, expired, cross-type and wrong-domain envelopes before any work", async () => {
    const readiness = vi.fn(async () => ({ ready: true as const }));
    clearServicesForTests();
    registerService(echoService({ requestReadiness: readiness }));
    const now = nowSeconds();
    const variants: Array<Parameters<typeof gatewayQuoteRequest>[0]["overrides"]> = [
      { artifactType: "DispatchStatusQueryV1" },
      { artifactType: "ProviderIntakeRequestV1" },
      { schemaVersion: 2 as never },
      { environment: "mainnet" },
      { chainId: 8453 },
      { audience: "https://other-provider.example" },
      { signerKeyId: "gateway-quote" },
      { issuedAt: now - 120, validBefore: now },
      { issuedAt: now + 40, validBefore: now + 70 },
      { issuedAt: now, validBefore: now + 121 },
      { privateKey: `0x${"12".repeat(32)}` as Hex },
    ];
    for (const overrides of variants) {
      const error = await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer, overrides })));
      expect(error).toBeInstanceOf(QuoteRefusal);
      expect((error as QuoteRefusal).status).toBe(401);
    }
    const signed = await gatewayQuoteRequest({ listing, request, payer });
    expect((await refusal(quotes().quote({ ...signed, extra: true }))) as QuoteRefusal)
      .toMatchObject({ status: 401, reason: "envelope" });
    expect((await refusal(quotes().quote({ ...signed, signature: "0x1234" }))) as QuoteRefusal)
      .toMatchObject({ status: 401, reason: "signature" });
    expect(readiness).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses payload binding faults without reading product readiness", async () => {
    const readiness = vi.fn(async () => ({ ready: true as const }));
    clearServicesForTests();
    registerService(echoService({ requestReadiness: readiness }));
    const now = nowSeconds();
    const payload = {
      outcomeId: "echo",
      listingManifestHash: listing.listingManifestHash,
      requestHash: canonicalHash(request),
      request,
      payer,
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...payload, payer: payer.toUpperCase().replace("0X", "0x") }, "binding"],
      [{ ...payload, outcomeId: "other" }, "outcome_policy"],
      [{ ...payload, listingManifestHash: `0x${"99".repeat(32)}` }, "outcome_policy"],
      [{ ...payload, requestHash: canonicalHash({ message: "other" }) }, "binding"],
      [{ ...payload, request: [request] }, "request_invalid"],
    ];
    for (const [variant, reason] of cases) {
      const envelope = await signGatewayEnvelope({
        artifactType: "ProviderQuoteRequestV1", issuedAt: now, validBefore: now + 60, payload: variant,
      });
      expect(await refusal(quotes().quote(envelope))).toMatchObject({ reason });
    }
    const { payer: _payer, ...withoutPayer } = payload;
    const missing = await signGatewayEnvelope({
      artifactType: "ProviderQuoteRequestV1", issuedAt: now, validBefore: now + 60, payload: withoutPayer,
    });
    expect(await refusal(quotes().quote(missing))).toMatchObject({ reason: "envelope" });
    expect(readiness).not.toHaveBeenCalled();
    expect(insertedQuotes()).toHaveLength(0);
  });

  it("returns reviewed schema field errors the gateway can relay", async () => {
    const error = await refusal(quotes().quote(
      await gatewayQuoteRequest({ listing, request: { note: "x" }, payer }),
    )) as QuoteRefusal;
    expect(error).toMatchObject({ status: 422, reason: "request_invalid" });
    const relayed = gatewayQuoteFieldErrors(error.status, error.body());
    expect(relayed.code).toBe("PROVIDER_QUOTE_REJECTED");
    expect(relayed.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "message", rule: "required" }),
      expect.objectContaining({ path: "note", rule: "unsupported-field" }),
    ]));
    expect(JSON.stringify(error.body())).not.toContain('"x"');
  });

  it("stops new quotes at the listing version's open obligations", async () => {
    db.openObligations = railOutcome().maxOpenOrders;
    expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
      .toEqual(new QuoteUnavailable("capacity"));
    const countCall = db.query.mock.calls.find(([sql]) => String(sql).includes("count(*)"));
    expect(`0x${(countCall?.[1]?.[0] as Buffer).toString("hex")}`).toBe(listing.listingManifestHash);
    db.openObligations -= 1;
    await expect(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))).resolves.toBeDefined();
  });

  it("stops new quotes while the skill is not accepting orders", async () => {
    clearServicesForTests();
    const service = echoService();
    registerService({ ...service, skills: [{ ...service.skills[0]!, acceptingNewOrders: false }] });
    expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
      .toEqual(new QuoteUnavailable("sales_paused"));
  });

  it("does not sell an external-job listing before external-job admission exists", async () => {
    clearServicesForTests();
    const service = echoService();
    registerService({
      ...service,
      adapter: {
        mode: "external-job",
        version: "v1",
        start: async () => ({ kind: "ambiguous", issue: { code: "timeout" } }),
        recoverStart: async () => ({ kind: "unknown" }),
        poll: async () => ({ kind: "pending" }),
      },
      skills: [{ ...service.skills[0]!, deadlines: { fulfillmentSeconds: 43_200 } }],
    });
    expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
      .toEqual(new QuoteUnavailable("service_unavailable"));
    expect(insertedQuotes()).toHaveLength(0);
  });

  it("stops new quotes, persisting nothing, for a listing whose served contract drifted", async () => {
    stopNewSales(listing.listingManifestHash, "contract_drift");
    expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
      .toEqual(new QuoteUnavailable("contract_drift"));
    expect(insertedQuotes()).toHaveLength(0);
    // Another listing version keeps selling.
    const other = railOutcome({ listingManifestHash: `0x${"7d".repeat(32)}` as Hex });
    const unaffected = new StandardQuoteService(railConfig([other]), 84532);
    await expect(unaffected.quote(await gatewayQuoteRequest({
      listing: gatewayListing(other), request, payer,
    }))).resolves.toBeDefined();
  });
});

describe("request readiness hook", () => {
  const withHook = (hook: NonNullable<Parameters<typeof echoService>[0]>["requestReadiness"]) => {
    clearServicesForTests();
    registerService(echoService({ requestReadiness: hook }));
  };

  it("receives a private copy of the validated input and the nullable quote payer", async () => {
    const seen: unknown[] = [];
    withHook(async (context) => {
      seen.push({ skillId: context.skillId, payer: context.payer, aborted: context.signal.aborted });
      context.input.message = "mutated by the hook";
      return { ready: true };
    });
    const body = await quotes().quote(await gatewayQuoteRequest({ listing, request, payer: null }));
    expect(seen).toEqual([{ skillId: "echo", payer: null, aborted: false }]);
    await expect(acceptQuoteAsGateway({ listing, body, request, payer: null })).resolves.toBeDefined();
  });

  it("declines before payment with reviewed field errors and creates no quote", async () => {
    withHook(async () => ({
      ready: false,
      fieldErrors: [{ path: "message", rule: "not_ready", message: "The product cannot accept this yet." }],
    }));
    const error = await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer })));
    expect(error).toMatchObject({
      status: 422,
      fieldErrors: [{ path: "message", rule: "not_ready", message: "The product cannot accept this yet." }],
    });
    expect(insertedQuotes()).toHaveLength(0);
  });

  it("cannot change the price or smuggle unreviewed output", async () => {
    for (const result of [
      { ready: true, grossAmount: "1" },
      { ready: false, fieldErrors: [] },
      { ready: false, fieldErrors: [{ path: "message", rule: "Bad Rule", message: "x" }] },
      { ready: false, fieldErrors: [{ path: "message", rule: "x", message: "a\nb" }] },
      { ready: false, fieldErrors: [{ path: "message", rule: "x", message: "y", raw: {} }] },
      "ready",
    ]) {
      withHook(async () => result as never);
      expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
        .toEqual(new QuoteUnavailable("service_unavailable"));
    }
    expect(insertedQuotes()).toHaveLength(0);
  });

  it("treats a throw or an expired readiness budget as unavailable", async () => {
    withHook(async () => { throw new Error("upstream detail must not leak"); });
    expect(await refusal(quotes().quote(await gatewayQuoteRequest({ listing, request, payer }))))
      .toEqual(new QuoteUnavailable("service_unavailable"));
    const envelope = await gatewayQuoteRequest({ listing, request, payer });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let observed: AbortSignal | null = null;
    withHook((context) => {
      observed = context.signal;
      return new Promise(() => undefined);
    });
    const pending = refusal(quotes().quote(envelope));
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await pending).toEqual(new QuoteUnavailable("service_unavailable"));
    expect(observed!.aborted).toBe(true);
  });
});

describe("quote lifetime measured at gateway receipt", () => {
  it("leaves more than the minimum payment window across the whole receipt skew", async () => {
    const body = await quotes().quote(await gatewayQuoteRequest({ listing, request, payer }));
    const issuedAt = (body as { issuedAt: number }).issuedAt;
    for (const receivedAt of [issuedAt - 30, issuedAt, issuedAt + 30]) {
      await expect(acceptQuoteAsGateway({ listing, body, request, payer, receivedAt })).resolves.toBeDefined();
    }
    for (const receivedAt of [issuedAt - 31, issuedAt + 31, issuedAt + 90]) {
      await expect(acceptQuoteAsGateway({ listing, body, request, payer, receivedAt }))
        .rejects.toThrow("PROVIDER_QUOTE_UNAVAILABLE");
    }
  });

  it("accepts request envelopes only inside their signed window at provider receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const issuedAt = 1_900_000_000;
    vi.setSystemTime(issuedAt * 1_000);
    const envelope = await gatewayQuoteRequest({ listing, request, payer, issuedAt });
    vi.setSystemTime((issuedAt + 59) * 1_000);
    await expect(quotes().quote(envelope)).resolves.toBeDefined();
    vi.setSystemTime((issuedAt + 60) * 1_000);
    expect(await refusal(quotes().quote(envelope))).toMatchObject({ reason: "envelope" });
    vi.setSystemTime((issuedAt - 30) * 1_000);
    await expect(quotes().quote(envelope)).resolves.toBeDefined();
    vi.setSystemTime((issuedAt - 31) * 1_000);
    expect(await refusal(quotes().quote(envelope))).toMatchObject({ reason: "envelope" });
  });
});

describe("signed intake discovery on the quote URL", () => {
  it("answers the published schema and partial-request field errors without a quote", async () => {
    const partial: Record<string, unknown> = {};
    const answer = await quotes().handle(
      await gatewayIntakeRequest(listing, partial) as unknown as Record<string, unknown>,
    );
    const payload = await acceptIntakeAsGateway(listing, partial, answer);
    expect(payload).toMatchObject({
      requiredFields: {},
      selectorsRequired: [],
      normalizedSelectors: {},
      supported: null,
      fieldErrors: [expect.objectContaining({ path: "message", rule: "required" })],
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("checks the intake artifact type and payload independently of quotes", async () => {
    const now = nowSeconds();
    const intakeWithPayer = await signGatewayEnvelope({
      artifactType: "ProviderIntakeRequestV1",
      issuedAt: now,
      validBefore: now + 60,
      payload: {
        outcomeId: "echo",
        listingManifestHash: listing.listingManifestHash,
        requestHash: canonicalHash(request),
        request,
        payer,
      },
    });
    expect(await refusal(quotes().handle(intakeWithPayer as never)))
      .toMatchObject({ kind: "intake", reason: "envelope" });
    const quoteEnvelope = await gatewayQuoteRequest({ listing, request, payer });
    const relabeled = { ...quoteEnvelope, artifactType: "ProviderIntakeRequestV1" };
    expect(await refusal(quotes().handle(relabeled as never))).toMatchObject({ kind: "intake" });
    expect(db.query).not.toHaveBeenCalled();
  });
});
