import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { canonicalHash } from "./canonical.js";

/**
 * How long past its listing version's fulfillment window an unreferenced
 * quote may still back a first dispatch: the gateway re-dispatches a
 * timely-paid order until its first release observation plus the snapshot's
 * fulfillment window, and that observation can trail payment. Thirty days
 * covers release delays with room to spare; quotes are small.
 */
export const QUOTE_DISPATCH_MARGIN_SECONDS = 30 * 86_400;

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

/** The exact seven fields a provider quote signs; the gateway hashes the same object. */
export interface ProviderQuotePayload {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  grossAmount: string;
  payer: Hex | null;
  issuedAt: number;
  validBefore: number;
}

/** A persisted quote: the signed fields and the adapter version that sold it. */
export interface PersistedProviderQuote extends ProviderQuotePayload {
  /**
   * The external-job adapter version that sold the quote, recorded when it
   * was issued (local metadata, never signed). Null when a synchronous
   * adapter sold it or it predates migration 010: its order then runs with
   * the service's current adapter.
   */
  adapterVersion: string | null;
}

export const providerQuoteHash = (payload: ProviderQuotePayload): Hex => canonicalHash({
  outcomeId: payload.outcomeId,
  listingManifestHash: payload.listingManifestHash,
  requestHash: payload.requestHash,
  grossAmount: payload.grossAmount,
  payer: payload.payer,
  issuedAt: payload.issuedAt,
  validBefore: payload.validBefore,
});

/**
 * Persist a quote before it is signed so a later dispatch can bind to it,
 * retained until its window plus its version's fulfillment window plus the
 * margin has passed (and forever once a claim names it), with the
 * external-job adapter version that sells it (null for a synchronous one).
 * The same signed quote issued again (same payer, request and second) keeps
 * the row, and the version, that recorded it first: that version sold it.
 */
export async function persistProviderQuote(
  payload: ProviderQuotePayload,
  fulfillmentSeconds: number,
  adapterVersion: string | null,
): Promise<Hex> {
  const quoteHash = providerQuoteHash(payload);
  await pool.query(
    `INSERT INTO provider_quotes
       (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
        issued_at,valid_before,retain_until,adapter_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($8::bigint + $9::bigint),$10)
     ON CONFLICT (quote_hash) DO NOTHING`,
    [
      bytes(quoteHash), payload.outcomeId, bytes(payload.listingManifestHash),
      bytes(payload.requestHash), payload.grossAmount, payload.payer,
      payload.issuedAt, payload.validBefore, fulfillmentSeconds + QUOTE_DISPATCH_MARGIN_SECONDS,
      adapterVersion,
    ],
  );
  return quoteHash;
}

/**
 * Delete, in bounded batches, quotes that can no longer back a dispatch:
 * past their recorded retention, issued before every installed version's
 * fulfillment window plus the margin could reach them, and named by no
 * claim. A trigger refuses any other deletion, whoever runs it. Runs as the
 * schema owner (the runtime role cannot delete).
 */
export async function pruneSettledQuotes(
  db: Queryable,
  longestFulfillmentSeconds: number,
  maxRows = 5_000,
): Promise<number> {
  let pruned = 0;
  while (pruned < maxRows) {
    const result = await db.query(
      `DELETE FROM provider_quotes WHERE quote_hash IN (
         SELECT q.quote_hash FROM provider_quotes q
          WHERE q.retain_until IS NOT NULL AND q.retain_until < now()
            AND q.valid_before + $1::bigint < extract(epoch FROM now())
            AND NOT EXISTS (SELECT 1 FROM provider_transactions t
                             WHERE t.provider_quote_hash = q.quote_hash)
          LIMIT $2)`,
      [longestFulfillmentSeconds + QUOTE_DISPATCH_MARGIN_SECONDS, Math.min(1_000, maxRows - pruned)],
    );
    pruned += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) === 0) break;
  }
  return pruned;
}

/**
 * Load a persisted quote by the hash the gateway carried in QuoteV1. The row
 * is accepted only when its signed content reproduces that hash.
 */
export async function loadProviderQuote(quoteHash: Hex): Promise<PersistedProviderQuote | null> {
  const result = await pool.query<{
    outcome_id: string;
    listing_manifest_hash: Buffer;
    request_hash: Buffer;
    gross_amount: string;
    payer: Hex | null;
    issued_at: string;
    valid_before: string;
    adapter_version: string | null;
  }>(
    `SELECT outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
            issued_at::text,valid_before::text,adapter_version
       FROM provider_quotes WHERE quote_hash=$1`,
    [bytes(quoteHash)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const quote: PersistedProviderQuote = {
    outcomeId: row.outcome_id,
    listingManifestHash: hex(row.listing_manifest_hash),
    requestHash: hex(row.request_hash),
    grossAmount: row.gross_amount,
    payer: row.payer,
    issuedAt: Number(row.issued_at),
    validBefore: Number(row.valid_before),
    adapterVersion: row.adapter_version ?? null,
  };
  if (providerQuoteHash(quote) !== quoteHash.toLowerCase()) {
    throw new Error("Persisted provider quote does not reproduce its hash");
  }
  return quote;
}

/**
 * Funded obligations for one listing version that are not yet terminal:
 * synchronous executions and external jobs in every phase, queued and
 * reconciling, polled or merely waiting, overdue or not, for their whole
 * lifetime. This is the gateway's own reservation scope (the listing
 * version). New quotes stop at the listing capacity; funded dispatches are
 * never refused by this count.
 */
export async function countOpenObligations(listingManifestHash: Hex): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_transactions
      WHERE listing_manifest_hash=$1 AND state IN ('executing','external_job')`,
    [bytes(listingManifestHash)],
  );
  return Number(result.rows[0]?.count ?? "0");
}
