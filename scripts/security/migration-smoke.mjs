import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const raw = process.env.DATABASE_URL_TEST?.trim();
if (!raw) throw new Error("DATABASE_URL_TEST is required");
const url = new URL(raw);
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (
  !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
  || !database
  || ["postgres", "template0", "template1"].includes(database)
) {
  throw new Error("migration smoke requires an explicit loopback disposable database");
}

const schema = `provider_smoke_${randomUUID().replaceAll("-", "")}`;
if (!/^provider_smoke_[a-f0-9]{32}$/.test(schema)) {
  throw new Error("unsafe smoke schema name");
}
const quoted = `"${schema}"`;
const expected = [
  "_migrations",
  "provider_quotes",
  "provider_runtime_listing_versions",
  "provider_schema_epoch",
  "provider_transactions",
  "rate_limit_buckets",
  "standard_evidence_admissions",
  "supplier_operations",
];
const migrations = readdirSync("src/core/db/migrations")
  .filter((name) => name.endsWith(".sql")).sort();
const rejects = (sql) => client.query(sql).then(() => false, () => true);
// The runtime sets the epoch marker on every connection (src/core/db/runtimeEpoch.ts).
const client = new pg.Client({ connectionString: raw, options: "-c daski.runtime_epoch=1" });
// A session from before the barrier: no marker at all.
const legacy = new pg.Client({ connectionString: raw });
const barred = (sql) => legacy.query(sql).then(
  () => false,
  (error) => /provider compatibility barrier/.test(error.message),
);

await client.connect();
await legacy.connect();
try {
  await client.query(`CREATE SCHEMA ${quoted}`);
  await client.query(`SET search_path TO ${quoted}`);
  await legacy.query(`SET search_path TO ${quoted}`);
  // Exactly as the migration runner creates and records its ledger.
  await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const name of migrations) {
    const sql = readFileSync(`src/core/db/migrations/${name}`, "utf8");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
      name, createHash("sha256").update(sql).digest("hex"),
    ]);
    await client.query("COMMIT");
  }
  const tables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
    [schema],
  );
  const actual = tables.rows.map((row) => row.tablename);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected migrated tables: ${actual.join(", ")}`);
  }
  await client.query(`SET search_path TO ${quoted}`);
  const claim = (id, validBefore) => `INSERT INTO provider_transactions (
       id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,
       payer,service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before
     ) VALUES (
       '${id}','https://gateway.example','${id}',decode(md5('${id}') || md5('${id}'),'hex'),
       decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
       '0x1111111111111111111111111111111111111111','smoke','echo',
       decode(repeat('44',32),'hex'),'executing',${validBefore}
     )`;
  await client.query(claim("task-smoke", "now() + interval '5 minutes'"));
  const bornTerminal = await client.query(`INSERT INTO provider_transactions (
       id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,service_slug,
       skill_id,listing_manifest_hash,state,result,result_hash,completed_at,dispatch_valid_before
     ) VALUES ('task-born-terminal','https://gateway.example','task-born-terminal',
       decode(repeat('55',32),'hex'),decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
       '0x1111111111111111111111111111111111111111','smoke','echo',decode(repeat('44',32),'hex'),
       'completed','{"status":"completed"}'::jsonb,decode(repeat('66',32),'hex'),now(),
       now() + interval '5 minutes')`).then(() => "admitted", (error) => error.message);
  if (bornTerminal !== "a claim is admitted as executing") {
    throw new Error("a claim was admitted already terminal");
  }
  for (const [id, validBefore] of [["task-late", "now() - interval '1 second'"], ["task-open", "NULL"]]) {
    await client.query("BEGIN");
    await client.query(claim(id, validBefore));
    if (!await rejects("COMMIT")) {
      throw new Error("a claim committed at or after its dispatch deadline");
    }
  }
  const invalid = await client.query(
    `UPDATE provider_transactions SET state='completed' WHERE id='task-smoke'`
  ).then(() => false, () => true);
  if (!invalid) throw new Error("terminal-result constraint was not enforced");
  const changed = `'{"fulfillment":null,"recovery":null,"support":{"reviewId":"r"}}'`;
  if (!await rejects(`UPDATE provider_transactions SET operations_projection=${changed}
      WHERE id='task-smoke'`)) {
    throw new Error("changed operations content kept its revision");
  }
  await client.query(`UPDATE provider_transactions SET operations_revision=1,
      operations_projection=${changed} WHERE id='task-smoke'`);
  if (!await rejects("UPDATE provider_transactions SET operations_revision=0 WHERE id='task-smoke'")) {
    throw new Error("operations revision decreased");
  }
  const frozenHash = "result_hash=decode(repeat('66',32),'hex')";
  const terminal = `state='completed',result='{"status":"completed"}'::jsonb,completed_at=now()`;
  if (!await rejects(`UPDATE provider_transactions SET ${terminal} WHERE id='task-smoke'`)) {
    throw new Error("a terminal transition did not freeze its result hash");
  }
  if (!await rejects(`UPDATE provider_transactions SET ${frozenHash} WHERE id='task-smoke'`)) {
    throw new Error("a pending task carried a result hash");
  }
  await client.query(`UPDATE provider_transactions SET ${terminal},${frozenHash} WHERE id='task-smoke'`);
  for (const change of [
    "state='failed'",
    `result='{"status":"completed","message":"changed"}'::jsonb`,
    "result_hash=decode(repeat('77',32),'hex')",
    "completed_at=now() + interval '1 second'",
    "payer='0x2222222222222222222222222222222222222222'",
    "dispatch_hash=decode(repeat('23',32),'hex')",
  ]) {
    if (!await rejects(`UPDATE provider_transactions SET ${change} WHERE id='task-smoke'`)) {
      throw new Error(`a frozen terminal identity or claim binding changed: ${change}`);
    }
  }
  const quote = (payer, issuedAt = 1_000, validBefore = 1_120) => `INSERT INTO provider_quotes
      (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
       issued_at,valid_before)
    VALUES (decode(md5(random()::text) || md5(random()::text),'hex'),'echo',
      decode(repeat('44',32),'hex'),decode(repeat('55',32),'hex'),'10000',${payer},
      ${issuedAt},${validBefore})`;
  await client.query(quote("NULL"));
  await client.query(quote("'0x1111111111111111111111111111111111111111'"));
  if (!await rejects(quote("'0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'"))) {
    throw new Error("quote payer must stay the gateway's lowercase literal");
  }
  if (!await rejects(quote("NULL", 1_120, 1_120))) {
    throw new Error("quote window constraint was not enforced");
  }
  // Legacy-process barrier: an unmarked session cannot write any provider
  // table, even with a statement matching no rows (the pre-R1 startup sweep).
  for (const sql of [
    `UPDATE provider_transactions
        SET state='failed',
            result='{"status":"failed","errorCode":"provider_restarted_during_execution"}'::jsonb,
            completed_at=now()
      WHERE state='executing' AND id='no-such-task'`,
    "DELETE FROM rate_limit_buckets WHERE bucket_key='no-such-bucket'",
    `INSERT INTO rate_limit_buckets (bucket_key,tokens,last_refill,expires_at)
       VALUES ('legacy',1,now(),now())`,
    "UPDATE provider_runtime_listing_versions SET superseded_at=now() WHERE false",
    "UPDATE provider_quotes SET gross_amount='1' WHERE false",
    "UPDATE supplier_operations SET attempts=attempts WHERE false",
    "UPDATE standard_evidence_admissions SET order_id=order_id WHERE false",
    "UPDATE provider_schema_epoch SET epoch=1",
    "INSERT INTO _migrations (name, checksum) VALUES ('legacy.sql', 'x')",
    "TRUNCATE rate_limit_buckets",
  ]) {
    if (!await barred(sql)) throw new Error(`an unmarked session wrote a provider table: ${sql}`);
  }
  // A newer schema epoch refuses older markers until a newer runtime lowers it.
  await client.query("UPDATE provider_schema_epoch SET epoch=2");
  if (!await rejects("UPDATE rate_limit_buckets SET tokens=tokens WHERE false")) {
    throw new Error("a runtime older than the schema epoch could write");
  }
  await client.query("SET daski.runtime_epoch = '2'");
  await client.query("UPDATE provider_schema_epoch SET epoch=1");
  await client.query("SET daski.runtime_epoch = '1'");
  process.stdout.write("minimal migration smoke passed\n");
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.query("SET search_path TO public").catch(() => undefined);
  await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
  await legacy.end().catch(() => undefined);
  await client.end();
}
