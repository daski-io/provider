import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { StandardEvidenceBundleV2 } from "./types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export async function admitStandardEvidence(
  orderId: string,
  bundle: StandardEvidenceBundleV2,
  authorizationKey: Hex,
  database: { connect(): Promise<PoolClient> } = pool,
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    for (const kind of ["deposit", "release"] as const) {
      const item = bundle[kind];
      const admitted = await client.query(
        `INSERT INTO standard_evidence_admissions (
           evidence_hash,order_id,evidence_kind,transaction_hash,block_number,block_hash,
           authorization_key,release_sequence,transaction_index,log_index,
           source_fingerprints,canonical_evidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (evidence_hash) DO UPDATE
           SET evidence_hash=EXCLUDED.evidence_hash
         WHERE standard_evidence_admissions.order_id=EXCLUDED.order_id
           AND standard_evidence_admissions.evidence_kind=EXCLUDED.evidence_kind
         RETURNING evidence_hash`,
        [
          bytes(item.evidenceHash), orderId, kind, item.transactionHash,
          item.blockNumber, item.blockHash,
          kind === "deposit" ? bytes(authorizationKey) : null,
          kind === "release" ? bundle.release.releaseSequence : null,
          item.transactionIndex, item.logIndex, JSON.stringify(item.sources),
          item.canonicalEvidence,
        ],
      );
      if (admitted.rowCount !== 1) {
        throw new Error("Chain evidence was already admitted for another order");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
