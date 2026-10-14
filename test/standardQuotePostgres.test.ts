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
import {
  countOpenObligations,
  loadProviderQuote,
  pruneSettledQuotes,
  QUOTE_DISPATCH_MARGIN_SECONDS,
} from "../src/core/standardRail/quoteStore.js";
import { completeTransaction } from "../src/core/standardRail/transactionStore.js";
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
    // Bounded: a request left hanging by a failed test must not skip the drop.
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
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
    // Claims are admitted as executing; a completed one is finished the way
    // the runtime does it, freezing its result hash.
    const insert = async (id: string, listingByte: string, state: "executing" | "completed") => {
      const claimed = await pool.query<{ token: string }>(
        `INSERT INTO provider_transactions (
           id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
           service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
           execution_owner,execution_lease_token,execution_lease_expires_at
         ) VALUES ($1,'https://gateway.example',$1,decode(md5($1) || md5($1),'hex'),
           decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),$2,'dummy','echo',
           decode(repeat($3,32),'hex'),'executing',now() + interval '5 minutes',
           gen_random_uuid(),gen_random_uuid(),now() + interval '1 hour')
         RETURNING execution_lease_token AS token`,
        [id, payer, listingByte],
      );
      if (state === "completed") {
        await completeTransaction(id, claimed.rows[0]!.token, { status: "completed" });
      }
    };
    await insert("task-a1", "aa", "executing");
    await insert("task-a2", "aa", "executing");
    await insert("task-a3", "aa", "completed");
    await insert("task-b1", "bb", "executing");
    await expect(countOpenObligations(`0x${"aa".repeat(32)}` as Hex)).resolves.toBe(2);
    await expect(countOpenObligations(`0x${"bb".repeat(32)}` as Hex)).resolves.toBe(1);
  });
  it("retains each quote for its dispatch window and prunes only settled, unreferenced ones", async () => {
    const listing = gatewayListing();
    const service = new StandardQuoteService(railConfig(), 84532);
    const body = await service.quote(await gatewayQuoteRequest({ listing, request: { message: "retain" }, payer }));
    const accepted = await acceptQuoteAsGateway({ listing, body, request: { message: "retain" }, payer });
    const issued = (await pool.query(
      "SELECT extract(epoch FROM retain_until)::bigint::text AS retain FROM provider_quotes WHERE quote_hash=$1",
      [Buffer.from(accepted.providerQuoteHash.slice(2), "hex")],
    )).rows[0] as { retain: string };
    // validBefore + the version's 900-second window + the 30-day margin.
    expect(Number(issued.retain)).toBe(accepted.validBefore + 900 + QUOTE_DISPATCH_MARGIN_SECONDS);

    const old = Math.floor(Date.now() / 1_000) - 400 * 86_400;
    const quote = (byte: string, retainUntil: string) => pool.query(
      `INSERT INTO provider_quotes
         (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,issued_at,valid_before,retain_until)
       VALUES (decode(repeat($1,32),'hex'),'echo',decode(repeat('11',32),'hex'),decode(repeat('12',32),'hex'),
         '10000',NULL,$2::bigint,$2::bigint + 120,${retainUntil})`,
      [byte, old],
    );
    await quote("f1", "now() - interval '1 day'");
    await quote("f2", "now() + interval '1 day'");
    await quote("f3", "NULL");
    await quote("f4", "now() - interval '1 day'");
    await pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
         execution_owner,execution_lease_token,execution_lease_expires_at,provider_quote_hash
       ) VALUES ('task-quoted','https://gateway.example','ord_quoted',decode(repeat('f5',32),'hex'),
         decode(repeat('f6',32),'hex'),decode(repeat('f7',32),'hex'),$1,'dummy','echo',
         decode(repeat('11',32),'hex'),'executing',now() + interval '5 minutes',
         gen_random_uuid(),gen_random_uuid(),now() + interval '1 hour',decode(repeat('f4',32),'hex'))`,
      [payer],
    );
    const fixtures = ["f1", "f2", "f3", "f4"].map((byte) => Buffer.from(byte.repeat(32), "hex"));
    const remaining = async () => (await pool.query<{ hash: string }>(
      "SELECT encode(quote_hash,'hex') AS hash FROM provider_quotes WHERE quote_hash = ANY($1) ORDER BY 1",
      [fixtures],
    )).rows.map((row) => row.hash.slice(0, 2));
    // A window longer than the quote's age keeps even a settled quote.
    await expect(pruneSettledQuotes(pool, 500 * 86_400)).resolves.toBe(0);
    await expect(pruneSettledQuotes(pool, 900)).resolves.toBe(1);
    expect(await remaining()).toEqual(["f2", "f3", "f4"]);
    await expect(pool.query("DELETE FROM provider_quotes WHERE quote_hash=decode(repeat('f4',32),'hex')"))
      .rejects.toThrow("retained while it may back a dispatch");
    expect(await loadProviderQuote(accepted.providerQuoteHash)).not.toBeNull();
  });
});
