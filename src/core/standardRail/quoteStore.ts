import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { parseSupplierCostCeiling, type SupplierCostCeiling } from "../serviceRegistry/supplierCost.js";
import { canonicalHash } from "./canonical.js";
import { MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS } from "./dispatchContract.js";

/**
 * How long past its own validBefore a provider quote stays an obligation:
 * the first-dispatch bound plus one day, for the longest dispatch envelope
 * lifetime and clock skew. The gateway's QuoteV1 never outlives the provider
 * quote it names, so no new claim can name a quote after this; one that no
 * claim names may then be deleted (migration 014 enforces the same rule).
 */
export const QUOTE_RETENTION_SECONDS = MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS + 86_400;

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

/** A persisted quote: the signed fields, the adapter version that sold it and its spend ceiling. */
export interface PersistedProviderQuote extends ProviderQuotePayload {
  /**
   * The external-job adapter version that sold the quote, recorded when it
   * was issued (local metadata, never signed). Null when a synchronous
   * adapter sold it or it predates migration 010: its order then runs with
   * the service's current adapter.
   */
  adapterVersion: string | null;
  /**
   * The supplier-cost ceiling recorded when the quote was issued (local
   * metadata, never signed): the supplier price the service reported and
   * the tolerance in force. Null when the service reported none or the
   * quote predates migration 013; the order's adapter then spends nothing.
   */
  supplierCostCeiling: SupplierCostCeiling | null;
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
 * with the external-job adapter version that sells it (null for a
 * synchronous one), the control profile it is issued under and its
 * supplier-cost ceiling (null when the service reported no supplier price).
 * It is kept for its validBefore plus QUOTE_RETENTION_SECONDS, and forever
 * once a claim names it. The same signed quote issued again (same payer,
 * request and second) keeps the row, the version, the profile and the
 * ceiling that recorded it first.
 */
export async function persistProviderQuote(
  payload: ProviderQuotePayload,
  sale: {
    adapterVersion: string | null;
    controlProfileHash: Hex;
    supplierCostCeiling: SupplierCostCeiling | null;
  },
): Promise<Hex> {
  const quoteHash = providerQuoteHash(payload);
  await pool.query(
    `INSERT INTO provider_quotes
       (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
        issued_at,valid_before,adapter_version,provider_control_profile_hash,supplier_cost_ceiling)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (quote_hash) DO NOTHING`,
    [
      bytes(quoteHash), payload.outcomeId, bytes(payload.listingManifestHash),
      bytes(payload.requestHash), payload.grossAmount, payload.payer,
      payload.issuedAt, payload.validBefore, sale.adapterVersion, bytes(sale.controlProfileHash),
      sale.supplierCostCeiling === null ? null : JSON.stringify(sale.supplierCostCeiling),
    ],
  );
  return quoteHash;
}

/**
 * Delete, in bounded batches, quotes no dispatch can name any more: past
 * their validBefore plus QUOTE_RETENTION_SECONDS and named by no claim. A
 * trigger refuses any other deletion, whoever runs it (migration 014). Runs
 * as the schema owner (the runtime role cannot delete).
 */
export async function pruneRetiredQuotes(db: Queryable, maxRows = 5_000): Promise<number> {
  let pruned = 0;
  while (pruned < maxRows) {
    const result = await db.query(
      `DELETE FROM provider_quotes WHERE quote_hash IN (
         SELECT q.quote_hash FROM provider_quotes q
          WHERE q.valid_before + $1::bigint < extract(epoch FROM now())
            AND NOT EXISTS (SELECT 1 FROM provider_transactions t
                             WHERE t.provider_quote_hash = q.quote_hash)
          LIMIT $2)`,
      [QUOTE_RETENTION_SECONDS, Math.min(1_000, maxRows - pruned)],
    );
    pruned += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) === 0) break;
  }
  return pruned;
}

/**
 * Load a persisted quote by the hash the gateway carried in QuoteV1. The row
 * is accepted only when its signed content reproduces that hash and its
 * recorded supplier-cost ceiling, if any, is a valid one.
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
    supplier_cost_ceiling: unknown;
  }>(
    `SELECT outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
            issued_at::text,valid_before::text,adapter_version,supplier_cost_ceiling
       FROM provider_quotes WHERE quote_hash=$1`,
    [bytes(quoteHash)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const stored = row.supplier_cost_ceiling ?? null;
  const supplierCostCeiling = parseSupplierCostCeiling(stored);
  if (stored !== null && !supplierCostCeiling) {
    throw new Error("Persisted provider quote carries an invalid supplier-cost ceiling");
  }
  const quote: PersistedProviderQuote = {
    outcomeId: row.outcome_id,
    listingManifestHash: hex(row.listing_manifest_hash),
    requestHash: hex(row.request_hash),
    grossAmount: row.gross_amount,
    payer: row.payer,
    issuedAt: Number(row.issued_at),
    validBefore: Number(row.valid_before),
    adapterVersion: row.adapter_version ?? null,
    supplierCostCeiling,
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
