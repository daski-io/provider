import type { Address, Hex } from "viem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { pool } from "../db/pool.js";
import type { RuntimeListingCommitmentV1 } from "./runtimeCommitment.js";
import type {
  PreparedListing,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedSkillContract,
} from "./types.js";

export interface SplitterActivationCheckpoint {
  splitterDeploymentTransactionHash: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
}

/**
 * Self-contained runtime version bundle: everything the provider needs to
 * materialize its runtime configuration for this listing without the
 * orchestration journal, the gateway, or a static manifest.
 */
export interface ProviderRuntimeListingBundleV1 {
  schemaVersion: 1;
  listing: PreparedListing;
  skillContract: PublishedSkillContract | null;
  intent: ProviderServiceRegistrationIntentEnvelope;
  splitterTransactionHash: Hex | null;
  activationCheckpoint: SplitterActivationCheckpoint | null;
  providerIdentity: {
    agentWallet: Address;
    verifiedAtBlock: string;
  };
  policyRefs: {
    railPolicyHash: Hex;
    canonicalToken: Address;
    splitterFactory: Address;
    splitterFactoryRuntimeCodeHash: Hex;
    splitterCreationCodeHash: Hex;
  };
}

export interface RuntimeListingVersionInput {
  listingId: string;
  listingKey: Hex;
  skillId: string;
  paymentRequired: boolean;
  runtimeCommitmentHash: Hex;
  runtimeCommitment: RuntimeListingCommitmentV1;
  bundle: ProviderRuntimeListingBundleV1;
}

export interface RuntimeListingHead {
  gatewayOrigin: string;
  serviceId: Hex;
  skillId: string;
  listingId: string;
  listingKey: Hex;
  paymentRequired: boolean;
  runtimeCommitmentHash: Hex;
  runtimeCommitment: RuntimeListingCommitmentV1;
  bundle: ProviderRuntimeListingBundleV1;
  promotedAt: Date;
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

/**
 * Append-only runtime catalog promotion, scoped per gateway origin. The
 * whole service bundle promotes in one serializable transaction with the
 * current heads locked, so a crash or a competing promotion can never leave
 * a service half-promoted or headless. An unchanged commitment hash is a
 * no-op, so a sibling re-registration never touches a reused listing's
 * version row; a changed hash supersedes the head and appends the new
 * version; re-promoting a known hash restores it as the head without
 * rewriting its content.
 */
export async function promoteRuntimeListingVersions(
  gatewayOrigin: string,
  serviceId: Hex,
  versions: readonly RuntimeListingVersionInput[],
  database: Pick<Pool, "connect"> = pool,
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // Service-scoped advisory lock: first-ever promotions have no head rows
    // to lock, so competing promotions serialize here instead of racing the
    // partial unique index.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${gatewayOrigin}\n${serviceId.toLowerCase()}`],
    );
    for (const version of versions) {
      const head = await client.query<{ id: string; runtime_commitment_hash: Buffer }>(
        `SELECT id,runtime_commitment_hash FROM provider_runtime_listing_versions
          WHERE gateway_origin=$1 AND service_id=$2 AND skill_id=$3
            AND superseded_at IS NULL
          FOR UPDATE`,
        [gatewayOrigin, bytes(serviceId), version.skillId],
      );
      const current = head.rows[0];
      if (
        current &&
        bytes(version.runtimeCommitmentHash).equals(current.runtime_commitment_hash)
      ) continue;
      if (current) {
        await client.query(
          `UPDATE provider_runtime_listing_versions
              SET superseded_at=now() WHERE id=$1 AND superseded_at IS NULL`,
          [current.id],
        );
      }
      await client.query(
        `INSERT INTO provider_runtime_listing_versions
           (id,gateway_origin,service_id,skill_id,listing_id,listing_key,
            payment_required,runtime_commitment_hash,runtime_commitment,bundle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (gateway_origin,service_id,skill_id,runtime_commitment_hash)
         DO UPDATE SET superseded_at=NULL`,
        [
          randomUUID(),
          gatewayOrigin,
          bytes(serviceId),
          version.skillId,
          version.listingId,
          bytes(version.listingKey),
          version.paymentRequired,
          bytes(version.runtimeCommitmentHash),
          version.runtimeCommitment,
          version.bundle,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Any installed version: the new-sale head, or a superseded one old orders still name. */
export interface RuntimeListingVersion extends RuntimeListingHead {
  supersededAt: Date | null;
}

export async function loadRuntimeListingHeads(
  gatewayOrigin?: string,
): Promise<RuntimeListingHead[]> {
  return (await loadRuntimeListingVersions(gatewayOrigin))
    .filter((version) => version.supersededAt === null)
    .map(({ supersededAt: _superseded, ...head }) => head);
}

/**
 * Every installed version, heads and superseded alike. Superseding never
 * deletes a version: orders paid against it are serviced with its own
 * admitted definition, looked up by its runtime commitment hash.
 */
export async function loadRuntimeListingVersions(
  gatewayOrigin?: string,
  database: Pick<Pool, "query"> = pool,
): Promise<RuntimeListingVersion[]> {
  const result = await database.query<{
    gateway_origin: string;
    service_id: Buffer;
    skill_id: string;
    listing_id: string;
    listing_key: Buffer;
    payment_required: boolean;
    runtime_commitment_hash: Buffer;
    runtime_commitment: unknown;
    bundle: unknown;
    promoted_at: Date;
    superseded_at: Date | null;
  }>(
    `SELECT gateway_origin,service_id,skill_id,listing_id,listing_key,
            payment_required,runtime_commitment_hash,runtime_commitment,
            bundle,promoted_at,superseded_at
       FROM provider_runtime_listing_versions
      WHERE ($1::text IS NULL OR gateway_origin=$1)
      ORDER BY gateway_origin,skill_id,promoted_at,runtime_commitment_hash`,
    [gatewayOrigin ?? null],
  );
  return result.rows.map((row) => ({
    gatewayOrigin: row.gateway_origin,
    serviceId: hex(row.service_id),
    skillId: row.skill_id,
    listingId: row.listing_id,
    listingKey: hex(row.listing_key),
    paymentRequired: row.payment_required,
    runtimeCommitmentHash: hex(row.runtime_commitment_hash),
    runtimeCommitment: row.runtime_commitment as RuntimeListingCommitmentV1,
    bundle: row.bundle as ProviderRuntimeListingBundleV1,
    promotedAt: row.promoted_at,
    supersededAt: row.superseded_at,
  }));
}
