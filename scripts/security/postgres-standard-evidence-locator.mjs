import { randomUUID } from "node:crypto";

const { admitStandardEvidence } = await import(
  "../../dist/core/standardRail/evidenceAdmissions.js"
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyStandardEvidenceLocatorIndex(pool) {
  const schema = `standard_evidence_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    const installedIndex = await client.query(
      `SELECT pg_get_indexdef(
         to_regclass('public.standard_evidence_chain_locator_unique_idx')
       ) AS definition`,
    );
    const indexSql = installedIndex.rows[0]?.definition;
    assert(indexSql, "standard evidence locator index is missing");
    const scratchIndexSql = indexSql.replace(
      / ON public\.standard_evidence_admissions /,
      ` ON "${schema}".standard_evidence_admissions `,
    );
    assert(
      scratchIndexSql !== indexSql,
      "standard evidence locator index targets the wrong table",
    );

    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE standard_evidence_admissions (
      evidence_hash BYTEA PRIMARY KEY,
      order_id TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      block_hash TEXT NOT NULL,
      authorization_key BYTEA,
      transaction_index INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      release_sequence NUMERIC(20,0),
      source_fingerprints JSONB NOT NULL,
      canonical_evidence JSONB NOT NULL,
      CHECK (
        (evidence_kind = 'deposit' AND release_sequence IS NULL) OR
        (evidence_kind = 'release' AND release_sequence BETWEEN 1 AND 18446744073709551615)
      )
    )`);
    await client.query(scratchIndexSql);

    const scopedPool = {
      connect: async () => ({
        query: client.query.bind(client),
        release: () => undefined,
      }),
    };
    const hash = (digit) => `0x${digit.repeat(64)}`;
    const item = (evidenceHash, transactionHash, logIndex) => ({
      evidenceHash,
      transactionHash,
      blockNumber: "100",
      blockHash: hash("f"),
      transactionIndex: 1,
      logIndex,
      sources: ["rpc-a.example", "rpc-b.example"],
      canonicalEvidence: { evidenceHash },
    });
    const bundle = (depositHash, depositTransaction, releaseHash, releaseTransaction) => ({
      deposit: item(depositHash, depositTransaction, 3),
      release: { ...item(releaseHash, releaseTransaction, 7), releaseSequence: "1" },
    });
    const releaseTransaction = hash("a");
    await admitStandardEvidence(
      "order-release-a",
      bundle(hash("1"), hash("b"), hash("2"), releaseTransaction),
      hash("c"),
      scopedPool,
    );
    await admitStandardEvidence(
      "order-release-b",
      bundle(hash("3"), hash("d"), hash("4"), releaseTransaction),
      hash("e"),
      scopedPool,
    );
    const releases = await client.query(
      "SELECT count(*)::int AS count FROM standard_evidence_admissions WHERE evidence_kind='release'",
    );
    assert(releases.rows[0]?.count === 2, "shared release evidence was rejected");

    let duplicateRejected = false;
    try {
      await admitStandardEvidence(
        "order-deposit-reuse",
        bundle(hash("5"), hash("b"), hash("6"), hash("6")),
        hash("7"),
        scopedPool,
      );
    } catch (error) {
      duplicateRejected = error?.code === "23505";
    }
    assert(duplicateRejected, "duplicate deposit locator was accepted");
  } finally {
    await client.query("RESET search_path").catch(() => undefined);
    await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
    client.release();
  }
}
