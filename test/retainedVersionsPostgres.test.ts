import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_retained_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import { StandardQuoteService } from "../src/core/standardRail/quote.js";
import { clearSalesStopsForTests, stopNewSales } from "../src/core/standardRail/salesStops.js";
import { verifyRetainedObligations } from "../src/core/standardRail/retainedObligations.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { acceptLifecycleAnswerAsGateway, gatewayLifecycleCall, LIFECYCLE_HEADERS } from "./gatewayLifecycleWire.js";
import { dispatchOrder, quoteOrder, type GatewayOrder } from "./gatewayOrderFixture.js";
import {
  acceptDispatchSnapshotAsGateway,
  classifyDispatchAnswer,
  gatewayQuoteRequest,
  nowSeconds,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";
import { echoService, gatewayListing, railConfig, railOutcome } from "./standardRailServiceFixture.js";

// The wallet the superseded version was registered with, rotated away since.
const previousKey = `0x${"6c".repeat(32)}` as Hex;
const previousWallet = privateKeyToAccount(previousKey).address;
const previousAudience = "https://old-provider.example";
// v1 was sold at 5000 with a required language; the build now sells v2 at 10000.
const v1 = railOutcome({
  listingManifestHash: `0x${"a1".repeat(32)}` as Hex,
  providerOfferHash: `0x${"a2".repeat(32)}` as Hex,
  fixedGrossAmount: "5000",
  providerTerminalAttestationKey: previousWallet,
  requestSchema: {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1, maxLength: 500 },
      language: { type: "string", enum: ["en", "fr"] },
    },
    required: ["message", "language"],
    additionalProperties: false,
  },
});
const retained = { versions: [v1], keys: [previousKey], audiences: [previousAudience] };
const previousKeys = { providerAuthorityKey: previousWallet, providerTerminalAttestationKey: previousWallet };

// C-T06 / L-T10 (versions, schemas, keys and URLs that apply before external
// jobs): an order paid against a superseded listing version is admitted and
// read with that version's definition, keys and audience.
describePostgres("retained listing versions against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness | null = null;

  /** v1's readiness quote, issued while v1 was the head of the previous build. */
  async function quoteUnderPreviousBuild(): Promise<GatewayOrder> {
    clearServicesForTests();
    registerService(echoService({
      skills: [{ ...echoService().skills[0]!, fixedPriceAtomic: "5000" }],
    }));
    const signer = privateKeyToAccount(previousKey);
    const quotes = new StandardQuoteService(railConfig([v1]), 84532, {
      sign: (digest) => signer.signMessage({ message: { raw: digest } }),
    });
    return quoteOrder({
      quotes, outcome: v1, request: { message: "bonjour", language: "fr" }, providerAuthorityKey: previousWallet,
    });
  }

  async function admitV1(harness: RailHarness) {
    const order = await quoteUnderPreviousBuild();
    const dispatched = await dispatchOrder({ order, outcome: v1, config: harness.config });
    clearServicesForTests();
    registerService(harness.service);
    return { order, dispatched, answer: await harness.post("/standard-rail/dispatch", dispatched.body) };
  }

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_retained", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await rail?.close();
    rail = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("refuses an order whose version this build does not retain", async () => {
    rail = await startRailHarness();
    const { answer } = await admitV1(rail);
    expect([answer.status, json(answer)]).toEqual([409, { error: "dispatch_rejected", reason: "outcome_policy" }]);
  });

  it("admits a funded order on a superseded version with its own schema, price and keys", async () => {
    rail = await startRailHarness({ retained });
    const { order, dispatched, answer } = await admitV1(rail);
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(answer), dispatchHash: dispatched.dispatchHash, ...previousKeys,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    const claim = (await pool.query(
      "SELECT listing_manifest_hash AS listing, result FROM provider_transactions WHERE order_id=$1",
      [order.orderId],
    )).rows[0] as { listing: Buffer; result: { status: string } };
    expect(`0x${claim.listing.toString("hex")}`).toBe(v1.listingManifestHash);
    expect(claim.result.status).toBe("completed");

    // Status and lifecycle reads carry the keys v1's snapshot names, at its audience.
    const issuedAt = nowSeconds();
    const query = await signGatewayEnvelope({
      artifactType: "DispatchStatusQueryV1",
      audience: previousAudience,
      issuedAt,
      validBefore: issuedAt + 60,
      payload: { orderId: order.orderId, dispatchHash: dispatched.dispatchHash, issuedAt, validBefore: issuedAt + 60 },
    });
    const status = await rail.post("/standard-rail/dispatch/status", { query });
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(status), dispatchHash: dispatched.dispatchHash, ...previousKeys,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    const taskId = String(json(status).taskId);
    for (const action of ["status", "artifact"] as const) {
      const call = await gatewayLifecycleCall({
        orderId: order.orderId, providerTaskId: taskId, action, payer: order.payer,
        grant: { audience: previousAudience },
      });
      const read = await rail.post("/standard-rail/lifecycle", call, LIFECYCLE_HEADERS);
      await expect(acceptLifecycleAnswerAsGateway({
        value: json(read), action, orderId: order.orderId, providerTaskId: taskId,
        resultSchema: echoResultSchema(), ...previousKeys,
      })).resolves.toMatchObject({ body: { state: "completed" } });
    }
    // New sales keep the current audience only.
    const quote = await rail.post("/standard-rail/quote", {
      request: await gatewayQuoteRequest({
        listing: gatewayListing(rail.outcome), request: { message: "hi" }, payer: null,
        overrides: { audience: previousAudience },
      }),
    });
    expect([quote.status, json(quote).reason]).toEqual([401, "envelope"]);
  });

  it("answers unavailable rather than sign with a key the snapshot does not name, and refuses to boot", async () => {
    rail = await startRailHarness({ retained });
    const { order, dispatched } = await admitV1(rail);
    await rail.close();
    rail = await startRailHarness({ retained: { versions: [v1] } });
    const status = await rail.status(order.orderId, dispatched.dispatchHash);
    expect([status.status, status.text]).toEqual([503, ""]);
    await expect(verifyRetainedObligations(pool, rail.config))
      .rejects.toThrow(/obligations are not serviceable by this build: 0xa1a1a1a1…a1a1 \(signing key not retained\)/);
    await expect(verifyRetainedObligations(pool, railConfig([railOutcome()], retained))).resolves.toBeUndefined();
  });

  it("refuses to boot while quotes of an unserviceable version may still be dispatched", async () => {
    await pool.query(
      `INSERT INTO provider_quotes
         (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,issued_at,valid_before)
       VALUES (decode(repeat('b1',32),'hex'),'echo',decode(repeat('b2',32),'hex'),
         decode(repeat('b3',32),'hex'),'10000',NULL,$1::bigint,$1::bigint + 120)`,
      [nowSeconds()],
    );
    const config = railConfig([railOutcome()], retained);
    await expect(verifyRetainedObligations(pool, config))
      .rejects.toThrow(/0xb2b2b2b2…b2b2 \(listing version not installed\)/);
    const known = { ...config, listingWallets: new Map([...config.listingWallets, [`0x${"b2".repeat(32)}` as Hex, previousWallet]]) };
    await expect(verifyRetainedObligations(pool, {
      ...known, unserviceable: new Map([[`0x${"b2".repeat(32)}` as Hex, "skill_not_installed" as const]]),
    })).rejects.toThrow(/0xb2b2b2b2…b2b2 \(skill_not_installed\)/);
    // A quote past every possible dispatch window owes nothing.
    await pool.query("UPDATE provider_quotes SET issued_at=1000, valid_before=1120 WHERE listing_manifest_hash=decode(repeat('b2',32),'hex')");
    await expect(verifyRetainedObligations(pool, known)).resolves.toBeUndefined();
    // A quote's recorded retention decides, even for an unknown version.
    const recorded = (byte: string, retainUntil: string) => pool.query(
      `INSERT INTO provider_quotes
         (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,issued_at,valid_before,retain_until)
       VALUES (decode(repeat($1,32),'hex'),'echo',decode(repeat('c2',32),'hex'),
         decode(repeat('b3',32),'hex'),'10000',NULL,$2::bigint,$2::bigint + 120,${retainUntil})`,
      [byte, nowSeconds()],
    );
    await recorded("c1", "now() - interval '1 second'");
    await expect(verifyRetainedObligations(pool, known)).resolves.toBeUndefined();
    await recorded("c3", "now() + interval '1 day'");
    await expect(verifyRetainedObligations(pool, known))
      .rejects.toThrow(/0xc2c2c2c2…c2c2 \(listing version not installed\)/);
    await pool.query("UPDATE provider_quotes SET retain_until=now() - interval '1 second' WHERE quote_hash=decode(repeat('c3',32),'hex')");
    await expect(verifyRetainedObligations(pool, known)).resolves.toBeUndefined();
  });

  it("keeps serving reads while new sales are paused", async () => {
    rail = await startRailHarness({ retained });
    const { order, dispatched } = await admitV1(rail);
    const sold = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const current = await dispatchOrder({ order: sold, outcome: rail.outcome, config: rail.config });
    expect(classifyDispatchAnswer(await rail.post("/standard-rail/dispatch", current.body))).toBe("accepted");
    await rail.close();
    rail = await startRailHarness({
      retained,
      service: { skills: [{ ...echoService().skills[0]!, acceptingNewOrders: false }] },
    });
    const paused = await rail.post("/standard-rail/quote", {
      request: await gatewayQuoteRequest({ listing: gatewayListing(rail.outcome), request: { message: "hi" }, payer: null }),
    });
    expect([paused.status, json(paused).reason]).toEqual([503, "sales_paused"]);
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(await rail.status(sold.orderId, current.dispatchHash)), dispatchHash: current.dispatchHash,
    })).resolves.toMatchObject({ body: { state: "completed" } });
    await expect(acceptDispatchSnapshotAsGateway({
      value: json(await rail.status(order.orderId, dispatched.dispatchHash)),
      dispatchHash: dispatched.dispatchHash, ...previousKeys,
    })).resolves.toMatchObject({ body: { state: "completed" } });
  });
  it("serves a repriced head's funded orders at the admitted price while its new sales stop", async () => {
    // The head was admitted at 10000; this build now prices the skill at 12000.
    const head = railOutcome();
    clearServicesForTests();
    registerService(echoService());
    const sold = await quoteOrder({ quotes: new StandardQuoteService(railConfig([head]), 84532), outcome: head });
    rail = await startRailHarness({
      service: { skills: [{ ...echoService().skills[0]!, fixedPriceAtomic: "12000" }] },
    });
    stopNewSales(head.listingManifestHash, "contract_drift");
    try {
      const funded = await dispatchOrder({ order: sold, outcome: head, config: rail.config });
      const answer = await rail.post("/standard-rail/dispatch", funded.body);
      await expect(acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: funded.dispatchHash }))
        .resolves.toMatchObject({ body: { state: "completed" } });
      const quote = await rail.post("/standard-rail/quote", {
        request: await gatewayQuoteRequest({ listing: gatewayListing(head), request: { message: "hi" }, payer: null }),
      });
      expect([quote.status, json(quote).reason]).toEqual([503, "contract_drift"]);
    } finally {
      clearSalesStopsForTests();
    }
  });
});
