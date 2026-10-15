import type { Address, Hex } from "viem";
import type { Queryable } from "../db/queryable.js";
import type { ProviderStandardRailConfig } from "./config.js";
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
  /**
   * Persisted quotes, every one of which may still back a timely-paid order's
   * first dispatch: only a verified gateway inventory could prove otherwise.
   */
  openQuotes: number;
  /**
   * Those an external-job adapter version sold: admitting each one's order
   * seals its input, so it needs an active encryption key.
   */
  externalJobQuotes: number;
  /** Unfinished external jobs; each needs its version's definition. */
  externalJobs: number;
  /**
   * Per service, the adapter versions those jobs were admitted under and
   * those that sold the open quotes (which run their orders when dispatched).
   */
  adapterVersions: Map<string, Set<string>>;
  /** The key ids their encrypted input, reference or candidate name. */
  encryptionKeyIds: Set<string>;
  /** The control profiles the open quotes were issued under, which their orders carry. */
  controlProfiles: Set<Hex>;
}

const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;

/**
 * Obligations by listing version: claims of this gateway audience, every
 * persisted quote (any may still back a first dispatch: the gateway's window
 * starts at a release observation nothing bounds) with the adapter versions
 * that sold them and the control profiles they were issued under, and
 * unfinished external jobs with the adapter versions and keys they need.
 */
export async function loadListingObligations(
  db: Queryable,
  gatewayAudience: string,
  catalog: Pick<ServicingView, "servicing">,
): Promise<Map<Hex, ListingObligation>> {
  const obligations = new Map<Hex, ListingObligation>();
  const entry = (hash: Hex) => {
    const current = obligations.get(hash) ?? {
      claims: 0, openQuotes: 0, externalJobQuotes: 0, externalJobs: 0, adapterVersions: new Map(),
      encryptionKeyIds: new Set(), controlProfiles: new Set(),
    };
    obligations.set(hash, current);
    return current;
  };
  const needs = (owed: ListingObligation, slug: string, versions: readonly string[]) => {
    for (const version of versions) owed.adapterVersions.set(slug, (owed.adapterVersions.get(slug) ?? new Set()).add(version));
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
    needs(owed, row.slug, [row.version]);
    for (const keyId of row.key_ids) owed.encryptionKeyIds.add(keyId);
  }
  const quotes = await db.query<{
    listing: Buffer; count: number; sold: number; versions: string[]; profiles: string[];
  }>(
    `SELECT listing_manifest_hash AS listing, count(*)::int AS count,
            count(*) FILTER (WHERE adapter_version IS NOT NULL)::int AS sold,
            COALESCE(array_agg(DISTINCT adapter_version)
              FILTER (WHERE adapter_version IS NOT NULL), '{}') AS versions,
            COALESCE(array_agg(DISTINCT encode(provider_control_profile_hash,'hex'))
              FILTER (WHERE provider_control_profile_hash IS NOT NULL), '{}') AS profiles
       FROM provider_quotes GROUP BY 1`,
  );
  for (const row of quotes.rows) {
    const hash = hex(row.listing);
    const owed = entry(hash);
    owed.openQuotes = row.count;
    owed.externalJobQuotes = row.sold;
    for (const profile of row.profiles) owed.controlProfiles.add(`0x${profile}` as Hex);
    // A version this build cannot materialize is refused for its definition;
    // otherwise each quote's order needs the adapter version that sold it.
    const outcome = catalog.servicing.get(hash);
    if (outcome) needs(owed, outcome.serviceSlug, row.versions);
  }
  return obligations;
}

/** Opaque, bounded reference to a listing version in diagnostics. */
const label = (hash: Hex) => `${hash.slice(0, 10)}…${hash.slice(-4)}`;

/**
 * Refuse to run (boot), take over (import) or activate unless this build
 * can service every obligation: each version with claims needs the signing
 * key its orders' snapshots name; each version with quotes, or with
 * unfinished external jobs, also needs its admitted definition (the jobs'
 * result contract); each quote needs the adapter version that sold it,
 * which will run its order, the control profile it was issued under, which
 * its order's dispatch carries, and, when its version is an external-job
 * one, an active key to seal the order's input at admission; and each
 * unfinished job needs its own adapter version, every encryption key its
 * stored state names and an active key to seal the reference or candidate
 * it may still produce.
 * Diagnostics name versions and profiles by hash prefix, adapter versions
 * and key ids, never key material.
 */
export function assertObligationsServiceable(args: {
  catalog: ServicingView;
  obligations: ReadonlyMap<Hex, ListingObligation>;
  signingWallets: ReadonlySet<Address>;
  externalJobs: ExternalJobServicing;
  /** The control profiles a first dispatch may carry: the current one and those retained. */
  controlProfiles: ReadonlySet<Hex>;
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
    for (const profile of [...obligation.controlProfiles].sort()) {
      if (!args.controlProfiles.has(profile)) problems.push(`${label(hash)} (control profile ${label(profile)} not retained)`);
    }
    if (obligation.externalJobs > 0 && !args.externalJobs.canSeal) {
      problems.push(`${label(hash)} (no active encryption key for unfinished external jobs)`);
    } else if (obligation.externalJobQuotes > 0 && !args.externalJobs.canSeal) {
      problems.push(`${label(hash)} (no active encryption key to admit the orders of open external-job quotes)`);
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
    controlProfiles: new Set([config.providerControlProfileHash, ...config.retainedControlProfileHashes]),
  });
}
