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

export const providerQuoteHash = (payload: ProviderQuotePayload): Hex => canonicalHash({
  outcomeId: payload.outcomeId,
  listingManifestHash: payload.listingManifestHash,
  requestHash: payload.requestHash,
  grossAmount: payload.grossAmount,
  payer: payload.payer,
  issuedAt: payload.issuedAt,
  validBefore: payload.validBefore,
});

/** Persist a quote before it is signed so a later dispatch can bind to it. */
export async function persistProviderQuote(payload: ProviderQuotePayload): Promise<Hex> {
  const quoteHash = providerQuoteHash(payload);
  await pool.query(
    `INSERT INTO provider_quotes
       (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
        issued_at,valid_before)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (quote_hash) DO NOTHING`,
    [
      bytes(quoteHash), payload.outcomeId, bytes(payload.listingManifestHash),
      bytes(payload.requestHash), payload.grossAmount, payload.payer,
      payload.issuedAt, payload.validBefore,
    ],
  );
  return quoteHash;
}

/**
 * Load a persisted quote by the hash the gateway carried in QuoteV1. The row
 * is accepted only when its content reproduces that hash.
 */
export async function loadProviderQuote(quoteHash: Hex): Promise<ProviderQuotePayload | null> {
  const result = await pool.query<{
    outcome_id: string;
    listing_manifest_hash: Buffer;
    request_hash: Buffer;
    gross_amount: string;
    payer: Hex | null;
    issued_at: string;
    valid_before: string;
  }>(
    `SELECT outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
            issued_at::text,valid_before::text
       FROM provider_quotes WHERE quote_hash=$1`,
    [bytes(quoteHash)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const payload: ProviderQuotePayload = {
    outcomeId: row.outcome_id,
    listingManifestHash: hex(row.listing_manifest_hash),
    requestHash: hex(row.request_hash),
    grossAmount: row.gross_amount,
    payer: row.payer,
    issuedAt: Number(row.issued_at),
    validBefore: Number(row.valid_before),
  };
  if (providerQuoteHash(payload) !== quoteHash.toLowerCase()) {
    throw new Error("Persisted provider quote does not reproduce its hash");
  }
  return payload;
}

/**
 * Funded obligations for one listing version that are not yet terminal. New
 * quotes stop at the listing capacity; funded dispatches are never refused
 * by this count.
 */
export async function countOpenObligations(listingManifestHash: Hex): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_transactions
      WHERE listing_manifest_hash=$1 AND state='executing'`,
    [bytes(listingManifestHash)],
  );
  return Number(result.rows[0]?.count ?? "0");
}
