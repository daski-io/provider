import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";

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
 * with the external-job adapter version that sells it (null for a
 * synchronous one) and the control profile it is issued under. Every quote
 * is kept: the gateway's first dispatch of a timely-paid order can come at
 * any time after its first release observation, which nothing bounds, so
 * only a verified gateway inventory could retire one (migration 011). The
 * same signed quote issued again (same payer, request and second) keeps the
 * row, the version and the profile that recorded it first.
 */
export async function persistProviderQuote(
  payload: ProviderQuotePayload,
  sale: { adapterVersion: string | null; controlProfileHash: Hex },
): Promise<Hex> {
  const quoteHash = providerQuoteHash(payload);
  await pool.query(
    `INSERT INTO provider_quotes
       (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
        issued_at,valid_before,adapter_version,provider_control_profile_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (quote_hash) DO NOTHING`,
    [
      bytes(quoteHash), payload.outcomeId, bytes(payload.listingManifestHash),
      bytes(payload.requestHash), payload.grossAmount, payload.payer,
      payload.issuedAt, payload.validBefore, sale.adapterVersion, bytes(sale.controlProfileHash),
    ],
  );
  return quoteHash;
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
