import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  "provider_transactions",
  "rate_limit_buckets",
  "standard_evidence_admissions",
  "supplier_operations",
];
const client = new pg.Client({ connectionString: raw });

await client.connect();
try {
  await client.query(`CREATE SCHEMA ${quoted}`);
  await client.query(`SET search_path TO ${quoted}`);
  await client.query(readFileSync("src/core/db/migrations/001_initial.sql", "utf8"));
  const tables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
    [schema],
  );
  const actual = tables.rows.map((row) => row.tablename);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected baseline tables: ${actual.join(", ")}`);
  }
  await client.query(`SET search_path TO ${quoted}`);
  await client.query(
    `INSERT INTO provider_transactions (
       id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,
       payer,service_slug,skill_id,listing_manifest_hash,state
     ) VALUES (
       'task-smoke','https://gateway.example','order-smoke',decode(repeat('11',32),'hex'),
       decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
       '0x1111111111111111111111111111111111111111','smoke','echo',
       decode(repeat('44',32),'hex'),'executing'
     )`,
  );
  const invalid = await client.query(
    `UPDATE provider_transactions SET state='completed' WHERE id='task-smoke'`
  ).then(() => false, () => true);
  if (!invalid) throw new Error("terminal-result constraint was not enforced");
  process.stdout.write("minimal migration smoke passed\n");
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.query("SET search_path TO public").catch(() => undefined);
  await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
  await client.end();
}
