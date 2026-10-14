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

/** What this build can do for unfinished external jobs: resume versions, open keys. */
export interface ExternalJobServicing {
  /** The external-job adapter versions this build resumes, per service. */
  adapterVersions(serviceSlug: string): ReadonlySet<string>;
  /** The encryption key ids this build can open. */
  keyIds: ReadonlySet<string>;
  /** Whether it can seal new job state (a reference or candidate): an active key. */
  canSeal: boolean;
}

/** What a listing version still owes. */
export interface ListingObligation {
  /** Admitted claims in any state: their reads are owed indefinitely. */
  claims: number;
  /** Persisted quotes that may still back a timely-paid order's first dispatch. */
  openQuotes: number;
  /** Unfinished external jobs; each needs its version's definition. */
  externalJobs: number;
  /** The adapter versions those jobs were admitted under, per service. */
  adapterVersions: Map<string, Set<string>>;
  /** The key ids their encrypted input, reference or candidate name. */
  encryptionKeyIds: Set<string>;
}

const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;

/**
 * Obligations by listing version: claims of this gateway audience, quotes
 * that may still back a first dispatch, and unfinished external jobs with
 * the adapter versions and keys they need. A quote's recorded retention
 * (`retain_until`, set when it was issued) decides; a quote from before
 * retention was recorded is held to its window plus its version's
 * fulfillment window and the margin, and to the longest window the gateway
 * admits when this build cannot materialize the version.
 */
export async function loadListingObligations(
  db: Queryable,
  gatewayAudience: string,
  catalog: Pick<ServicingView, "servicing">,
): Promise<Map<Hex, ListingObligation>> {
  const obligations = new Map<Hex, ListingObligation>();
  const entry = (hash: Hex) => {
    const current = obligations.get(hash) ?? {
      claims: 0, openQuotes: 0, externalJobs: 0, adapterVersions: new Map(), encryptionKeyIds: new Set(),
    };
    obligations.set(hash, current);
    return current;
  };
  const claims = await db.query<{ listing: Buffer; count: number }>(
    `SELECT listing_manifest_hash AS listing, count(*)::int AS count
       FROM provider_transactions WHERE gateway_audience=$1 GROUP BY 1`,
    [gatewayAudience],
  );
  for (const row of claims.rows) entry(hex(row.listing)).claims = row.count;
  const jobs = await db.query<{
    listing: Buffer; slug: string; version: string; count: number; key_ids: string[];
  }>(
    `SELECT t.listing_manifest_hash AS listing, t.service_slug AS slug, j.adapter_version AS version,
            count(*)::int AS count,
            array_remove(array_agg(DISTINCT j.input_key_id)
              || array_agg(DISTINCT j.job_reference_key_id)
              || array_agg(DISTINCT j.result_candidate_key_id), NULL) AS key_ids
       FROM provider_external_jobs j JOIN provider_transactions t ON t.id=j.task_id
      WHERE t.gateway_audience=$1 AND j.phase IN ('queued','starting','reconciling','polling')
      GROUP BY 1, 2, 3`,
    [gatewayAudience],
  );
  for (const row of jobs.rows) {
    const owed = entry(hex(row.listing));
    owed.externalJobs += row.count;
    owed.adapterVersions.set(row.slug, (owed.adapterVersions.get(row.slug) ?? new Set()).add(row.version));
    for (const keyId of row.key_ids) owed.encryptionKeyIds.add(keyId);
  }
  const quotes = await db.query<{
    listing: Buffer; retained: number; unrecorded: number; latest: string | null; now: string;
  }>(
    `SELECT listing_manifest_hash AS listing,
            count(*) FILTER (WHERE retain_until > now())::int AS retained,
            count(*) FILTER (WHERE retain_until IS NULL)::int AS unrecorded,
            (max(valid_before) FILTER (WHERE retain_until IS NULL))::text AS latest,
            floor(extract(epoch FROM now()))::bigint::text AS now
       FROM provider_quotes GROUP BY 1`,
  );
  for (const row of quotes.rows) {
    const hash = hex(row.listing);
    const window = catalog.servicing.get(hash)?.fulfillmentSeconds ?? MAX_FULFILLMENT_SECONDS;
    const unrecordedOpen = row.unrecorded > 0 && row.latest !== null
      && Number(row.latest) + window + QUOTE_DISPATCH_MARGIN_SECONDS > Number(row.now);
    const open = row.retained + (unrecordedOpen ? row.unrecorded : 0);
    if (open > 0) entry(hash).openQuotes = open;
  }
  return obligations;
}

/** Opaque, bounded reference to a listing version in diagnostics. */
const label = (hash: Hex) => `${hash.slice(0, 10)}…${hash.slice(-4)}`;

/**
 * Refuse to run (boot), take over (import) or activate unless this build
 * can service every obligation: each version with claims needs the signing
 * key its orders' snapshots name; each version whose quotes may still be
 * dispatched, or with unfinished external jobs, also needs its admitted
 * definition (the jobs' result contract); and each unfinished job needs its
 * own adapter version, every encryption key its stored state names and an
 * active key to seal the reference or candidate it may still produce.
 * Diagnostics name versions by hash prefix, adapter versions and key ids,
 * never key material.
 */
export function assertObligationsServiceable(args: {
  catalog: ServicingView;
  obligations: ReadonlyMap<Hex, ListingObligation>;
  signingWallets: ReadonlySet<Address>;
  externalJobs: ExternalJobServicing;
}): void {
  const problems: string[] = [];
  for (const [hash, obligation] of [...args.obligations].sort(([a], [b]) => a.localeCompare(b))) {
    if (obligation.claims === 0 && obligation.openQuotes === 0 && obligation.externalJobs === 0) continue;
    const wallet = args.catalog.listingWallets.get(hash);
    if (!wallet) {
      problems.push(`${label(hash)} (listing version not installed)`);
      continue;
    }
    if (!args.signingWallets.has(wallet)) problems.push(`${label(hash)} (signing key not retained)`);
    if ((obligation.openQuotes > 0 || obligation.externalJobs > 0) && !args.catalog.servicing.has(hash)) {
      problems.push(`${label(hash)} (${args.catalog.unserviceable.get(hash) ?? "definition_unavailable"})`);
    }
    for (const [slug, versions] of obligation.adapterVersions) {
      const resumable = args.externalJobs.adapterVersions(slug);
      for (const version of [...versions].sort()) {
        if (!resumable.has(version)) problems.push(`${label(hash)} (external-job adapter ${slug}@${version} not installed)`);
      }
    }
    for (const keyId of [...obligation.encryptionKeyIds].sort()) {
      if (!args.externalJobs.keyIds.has(keyId)) problems.push(`${label(hash)} (encryption key ${keyId} not configured)`);
    }
    if (obligation.externalJobs > 0 && !args.externalJobs.canSeal) {
      problems.push(`${label(hash)} (no active encryption key for unfinished external jobs)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`retained listing obligations are not serviceable by this build: ${problems.join(", ")}`);
  }
}

/** Boot and activation: this build serves nothing unless it can service every obligation it finds. */
export async function verifyRetainedObligations(
  db: Queryable,
  config: ProviderStandardRailConfig,
  externalJobs: ExternalJobServicing,
): Promise<void> {
  assertObligationsServiceable({
    catalog: config,
    obligations: await loadListingObligations(db, config.gatewayAudience, config),
    signingWallets: new Set([config.terminalAttestationKey, ...config.retainedSigningKeys.keys()]),
    externalJobs,
  });
}
