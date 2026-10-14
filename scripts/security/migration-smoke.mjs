import { randomUUID } from "node:crypto";
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
  "provider_quotes",
  "provider_runtime_listing_versions",
  "provider_transactions",
  "rate_limit_buckets",
  "standard_evidence_admissions",
  "supplier_operations",
];
const migrations = readdirSync("src/core/db/migrations")
  .filter((name) => name.endsWith(".sql")).sort();
const rejects = (sql) => client.query(sql).then(() => false, () => true);
const client = new pg.Client({ connectionString: raw });

await client.connect();
try {
  await client.query(`CREATE SCHEMA ${quoted}`);
  await client.query(`SET search_path TO ${quoted}`);
  for (const name of migrations) {
    await client.query(readFileSync(`src/core/db/migrations/${name}`, "utf8"));
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
  process.stdout.write("minimal migration smoke passed\n");
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.query("SET search_path TO public").catch(() => undefined);
  await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
  await client.end();
}
