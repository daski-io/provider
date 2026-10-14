import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_quote_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
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
import { countOpenObligations, loadProviderQuote } from "../src/core/standardRail/quoteStore.js";
import { acceptQuoteAsGateway, gatewayQuoteRequest } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoService, gatewayListing, railConfig } from "./standardRailServiceFixture.js";

const payer = `0x${"cd".repeat(20)}` as Hex;
const request = { message: "persist me" };

describePostgres("provider quotes in PostgreSQL", () => {
  let database: DisposableDatabase;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_quote", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await database?.drop();
  });

  beforeEach(() => {
    clearServicesForTests();
    registerService(echoService());
  });

  it("persists the exact signed fields so a later dispatch can reproduce the hash", async () => {
    const listing = gatewayListing();
    const service = new StandardQuoteService(railConfig(), 84532);
    const body = await service.quote(await gatewayQuoteRequest({ listing, request, payer }));
    const accepted = await acceptQuoteAsGateway({ listing, body, request, payer });
    await expect(loadProviderQuote(accepted.providerQuoteHash)).resolves.toEqual({
      outcomeId: "echo",
      listingManifestHash: listing.listingManifestHash,
      requestHash: (body as { requestHash: Hex }).requestHash,
      grossAmount: "10000",
      payer,
      issuedAt: accepted.issuedAt,
      validBefore: accepted.validBefore,
    });
    const unbound = await service.quote(await gatewayQuoteRequest({ listing, request, payer: null }));
    const unboundHash = (await acceptQuoteAsGateway({ listing, body: unbound, request, payer: null }))
      .providerQuoteHash;
    await expect(loadProviderQuote(unboundHash)).resolves.toMatchObject({ payer: null });
  });

  it("refuses a persisted row whose content no longer reproduces its hash", async () => {
    const listing = gatewayListing();
    const body = await new StandardQuoteService(railConfig(), 84532)
      .quote(await gatewayQuoteRequest({ listing, request, payer }));
    const { providerQuoteHash } = await acceptQuoteAsGateway({ listing, body, request, payer });
    await pool.query("UPDATE provider_quotes SET gross_amount='1' WHERE quote_hash=$1", [
      Buffer.from(providerQuoteHash.slice(2), "hex"),
    ]);
    await expect(loadProviderQuote(providerQuoteHash)).rejects.toThrow("does not reproduce its hash");
    await expect(loadProviderQuote(`0x${"00".repeat(32)}`)).resolves.toBeNull();
  });

  it("counts only nonterminal tasks of the same listing version as open obligations", async () => {
    const insert = (id: string, listingByte: string, state: "executing" | "completed") => pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,result,completed_at,
         dispatch_valid_before
       ) VALUES ($1,'https://gateway.example',$1,decode(md5($1) || md5($1),'hex'),
         decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),$2,'dummy','echo',
         decode(repeat($3,32),'hex'),$4,$5,$6,now() + interval '5 minutes')`,
      [id, payer, listingByte, state, state === "completed" ? '{"status":"completed"}' : null,
        state === "completed" ? new Date() : null],
    );
    await insert("task-a1", "aa", "executing");
    await insert("task-a2", "aa", "executing");
    await insert("task-a3", "aa", "completed");
    await insert("task-b1", "bb", "executing");
    await expect(countOpenObligations(`0x${"aa".repeat(32)}` as Hex)).resolves.toBe(2);
    await expect(countOpenObligations(`0x${"bb".repeat(32)}` as Hex)).resolves.toBe(1);
  });
});
