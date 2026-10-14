import type { Address, Hex } from "viem";
import type { Queryable } from "../db/queryable.js";
import { MAX_FULFILLMENT_SECONDS } from "../serviceRegistry/deadlines.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { QUOTE_DISPATCH_MARGIN_SECONDS } from "./quoteStore.js";
import type { UnserviceableReason } from "./servicingCatalog.js";
import type { ProviderOutcomeConfig } from "./types.js";

/** The parts of a servicing catalog obligations are judged against. */
export interface ServicingView {
  servicing: ReadonlyMap<Hex, ProviderOutcomeConfig>;
  listingWallets: ReadonlyMap<Hex, Address>;
  unserviceable: ReadonlyMap<Hex, UnserviceableReason>;
}


/** What a listing version still owes. */
export interface ListingObligation {
  /** Admitted claims in any state: their reads are owed indefinitely. */
  claims: number;
  /** Persisted quotes that may still back a timely-paid order's first dispatch. */
  openQuotes: number;
}

const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;

/**
 * Obligations by listing version: claims of this gateway audience and quotes
 * whose window plus the version's fulfillment window and the margin has not
 * passed. A version this build cannot materialize is held to the longest
 * window the gateway admits.
 */
export async function loadListingObligations(
  db: Queryable,
  gatewayAudience: string,
  catalog: Pick<ServicingView, "servicing">,
): Promise<Map<Hex, ListingObligation>> {
  const obligations = new Map<Hex, ListingObligation>();
  const entry = (hash: Hex) => {
    const current = obligations.get(hash) ?? { claims: 0, openQuotes: 0 };
    obligations.set(hash, current);
    return current;
  };
  const claims = await db.query<{ listing: Buffer; count: number }>(
    `SELECT listing_manifest_hash AS listing, count(*)::int AS count
       FROM provider_transactions WHERE gateway_audience=$1 GROUP BY 1`,
    [gatewayAudience],
  );
  for (const row of claims.rows) entry(hex(row.listing)).claims = row.count;
  const quotes = await db.query<{ listing: Buffer; latest: string; count: number; now: string }>(
    `SELECT listing_manifest_hash AS listing, max(valid_before)::text AS latest, count(*)::int AS count,
            floor(extract(epoch FROM now()))::bigint::text AS now
       FROM provider_quotes GROUP BY 1`,
  );
  for (const row of quotes.rows) {
    const hash = hex(row.listing);
    const window = catalog.servicing.get(hash)?.fulfillmentSeconds ?? MAX_FULFILLMENT_SECONDS;
    if (Number(row.latest) + window + QUOTE_DISPATCH_MARGIN_SECONDS > Number(row.now)) {
      entry(hash).openQuotes = row.count;
    }
  }
  return obligations;
}

/** Opaque, bounded reference to a listing version in diagnostics. */
const label = (hash: Hex) => `${hash.slice(0, 10)}…${hash.slice(-4)}`;

/**
 * Refuse to run (boot) or take over (import) unless this build can service
 * every obligation: each version with claims needs the signing key its
 * orders' snapshots name; each version whose quotes may still be dispatched
 * also needs its admitted definition, an installed handler and compilable
 * schemas. Diagnostics name versions by hash prefix, never key material.
 */
export function assertObligationsServiceable(args: {
  catalog: ServicingView;
  obligations: ReadonlyMap<Hex, ListingObligation>;
  signingWallets: ReadonlySet<Address>;
}): void {
  const problems: string[] = [];
  for (const [hash, obligation] of [...args.obligations].sort(([a], [b]) => a.localeCompare(b))) {
    if (obligation.claims === 0 && obligation.openQuotes === 0) continue;
    const wallet = args.catalog.listingWallets.get(hash);
    if (!wallet) {
      problems.push(`${label(hash)} (listing version not installed)`);
      continue;
    }
    if (!args.signingWallets.has(wallet)) problems.push(`${label(hash)} (signing key not retained)`);
    if (obligation.openQuotes > 0 && !args.catalog.servicing.has(hash)) {
      problems.push(`${label(hash)} (${args.catalog.unserviceable.get(hash) ?? "definition_unavailable"})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`retained listing obligations are not serviceable by this build: ${problems.join(", ")}`);
  }
}

/** Boot: this build serves nothing unless it can service every obligation it finds. */
export async function verifyRetainedObligations(
  db: Queryable,
  config: ProviderStandardRailConfig,
): Promise<void> {
  assertObligationsServiceable({
    catalog: config,
    obligations: await loadListingObligations(db, config.gatewayAudience, config),
    signingWallets: new Set([config.terminalAttestationKey, ...config.retainedSigningKeys.keys()]),
  });
}
