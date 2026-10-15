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
  "provider_async_admission",
  "provider_external_jobs",
  "provider_quotes",
  "provider_runtime_instances",
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
  const claim = (
    id, validBefore, lease = "gen_random_uuid(),gen_random_uuid(),now() + interval '30 seconds'",
    quoteHash = "NULL",
  ) =>
    `INSERT INTO provider_transactions (
       id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,
       payer,service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
       execution_owner,execution_lease_token,execution_lease_expires_at,provider_quote_hash
     ) VALUES (
       '${id}','https://gateway.example','${id}',decode(md5('${id}') || md5('${id}'),'hex'),
       decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
       '0x1111111111111111111111111111111111111111','smoke','echo',
       decode(repeat('44',32),'hex'),'executing',${validBefore},${lease},${quoteHash}
     )`;
  await client.query(claim("task-smoke", "now() + interval '5 minutes'"));
  if (!await rejects(claim("task-leaseless", "now() + interval '5 minutes'", "NULL,NULL,NULL"))) {
    throw new Error("an executing claim was admitted without an execution lease");
  }
  if (!await rejects(`UPDATE provider_transactions SET execution_lease_token=gen_random_uuid()
      WHERE id='task-smoke'`)) {
    throw new Error("an execution's lease token changed");
  }
  await client.query(`UPDATE provider_transactions
      SET execution_lease_expires_at=now() + interval '30 seconds' WHERE id='task-smoke'`);
  const bornTerminal = await client.query(`INSERT INTO provider_transactions (
       id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,service_slug,
       skill_id,listing_manifest_hash,state,result,result_hash,completed_at,dispatch_valid_before
     ) VALUES ('task-born-terminal','https://gateway.example','task-born-terminal',
       decode(repeat('55',32),'hex'),decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
       '0x1111111111111111111111111111111111111111','smoke','echo',decode(repeat('44',32),'hex'),
       'completed','{"status":"completed"}'::jsonb,decode(repeat('66',32),'hex'),now(),
       now() + interval '5 minutes')`).then(() => "admitted", (error) => error.message);
  if (bornTerminal !== "a claim is admitted as executing or as an external job") {
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
  // Quote retention (011): no quote is ever deleted, however old and whether
  // or not a claim names it, and a claim keeps the quote it was admitted
  // against.
  const retained = (byte, issuedAt = "1000") => `INSERT INTO provider_quotes
      (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
       issued_at,valid_before)
    VALUES (decode(repeat('${byte}',32),'hex'),'echo',decode(repeat('44',32),'hex'),
      decode(repeat('55',32),'hex'),'10000',NULL,${issuedAt},${issuedAt} + 120)`;
  const deleteQuote = (byte) => `DELETE FROM provider_quotes WHERE quote_hash=decode(repeat('${byte}',32),'hex')`;
  await client.query(retained("e1"));
  await client.query(retained("e2", "extract(epoch FROM now())::bigint"));
  await client.query(retained("e4"));
  await client.query(`UPDATE provider_transactions SET provider_quote_hash=decode(repeat('e4',32),'hex')
      WHERE id='task-smoke'`).then(
    () => { throw new Error("a claim's provider quote changed"); },
    (error) => { if (!/keeps its provider quote/.test(error.message)) throw error; },
  );
  await client.query(claim(
    "task-quoted", "now() + interval '5 minutes'", undefined, "decode(repeat('e4',32),'hex')",
  ));
  for (const byte of ["e1", "e2", "e4"]) {
    if (!await rejects(deleteQuote(byte))) throw new Error(`a provider quote was deleted: ${byte}`);
  }
  // The adapter version that sold a quote (010): a reviewed version or none,
  // never changed once recorded, not even on a quote that recorded none.
  const sold = (byte, version) => `INSERT INTO provider_quotes
      (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
       issued_at,valid_before,adapter_version)
    VALUES (decode(repeat('${byte}',32),'hex'),'echo',decode(repeat('44',32),'hex'),
      decode(repeat('55',32),'hex'),'10000',NULL,1000,1120,${version})`;
  await client.query(sold("f1", "'v1.2_b-3'"));
  for (const version of ["''", "'-v1'", "'v 1'", `'${"v".repeat(65)}'`]) {
    if (!await rejects(sold("f2", version))) throw new Error(`an invalid quote adapter version was recorded: ${version}`);
  }
  for (const [byte, version] of [["f1", "'v2'"], ["f1", "NULL"], ["e1", "'v1'"]]) {
    const change = await client.query(`UPDATE provider_quotes SET adapter_version=${version}
        WHERE quote_hash=decode(repeat('${byte}',32),'hex')`).then(() => "changed", (error) => error.message);
    if (change !== "a provider quote keeps the adapter version that sold it") {
      throw new Error(`a quote's recorded adapter version changed: ${byte} to ${version}`);
    }
  }
  // The control profile a quote was issued under (012): bytes32 or none,
  // never changed once recorded, not even on a quote that recorded none.
  const profiled = (byte, profile) => `INSERT INTO provider_quotes
      (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,
       issued_at,valid_before,provider_control_profile_hash)
    VALUES (decode(repeat('${byte}',32),'hex'),'echo',decode(repeat('44',32),'hex'),
      decode(repeat('55',32),'hex'),'10000',NULL,1000,1120,${profile})`;
  await client.query(profiled("d1", "decode(repeat('66',32),'hex')"));
  if (!await rejects(profiled("d2", "decode(repeat('66',31),'hex')"))) {
    throw new Error("a malformed quote control profile was recorded");
  }
  for (const [byte, profile] of [
    ["d1", "decode(repeat('77',32),'hex')"], ["d1", "NULL"], ["e1", "decode(repeat('66',32),'hex')"],
  ]) {
    const change = await client.query(`UPDATE provider_quotes SET provider_control_profile_hash=${profile}
        WHERE quote_hash=decode(repeat('${byte}',32),'hex')`).then(() => "changed", (error) => error.message);
    if (change !== "a provider quote keeps the control profile it was issued under") {
      throw new Error(`a quote's recorded control profile changed: ${byte} to ${profile}`);
    }
  }

  // External jobs: a claim in its own pending state commits only with its
  // job; phases follow the reviewed transitions; a queued job fails only
  // once its deadline passed and never after a start; and the claim and its
  // job finish together, frozen.
  const jobClaim = (id) => claim(id, "now() + interval '5 minutes'", "NULL,NULL,NULL")
    .replace("'executing'", "'external_job'");
  const job = (id, key, deadline = "now() + interval '12 hours'") => `INSERT INTO provider_external_jobs
      (task_id,adapter_version,idempotency_key,input_ciphertext,input_key_id,fulfillment_deadline)
    VALUES ('${id}','v1','${key}','daski:v1:input','primary',${deadline})`;
  await client.query("BEGIN");
  await client.query(jobClaim("task-jobless"));
  if (!await rejects("COMMIT")) throw new Error("an external-job claim committed without its job");
  await client.query("BEGIN");
  await client.query(jobClaim("task-job"));
  await client.query(job("task-job", "00000000-0000-8000-8000-000000000001"));
  await client.query("COMMIT");
  if (!await rejects(job("task-smoke", "00000000-0000-8000-8000-000000000002"))) {
    throw new Error("an external job was attached to a synchronous claim");
  }
  if (!await rejects(`UPDATE provider_transactions SET state='executing' WHERE id='task-job'`)) {
    throw new Error("an external-job claim changed its execution mode");
  }
  if (!await rejects(`UPDATE provider_external_jobs SET phase='polling',revision=1,
      job_reference_ciphertext='daski:v1:ref',job_reference_key_id='primary' WHERE task_id='task-job'`)) {
    throw new Error("a queued external job skipped its start");
  }
  await client.query(`UPDATE provider_external_jobs SET phase='starting',revision=1,
      first_start_attempt_at=now(),start_attempts=1,lease_owner=gen_random_uuid(),
      lease_token=gen_random_uuid(),lease_expires_at=now() + interval '90 seconds' WHERE task_id='task-job'`);
  for (const change of [
    "first_start_attempt_at=now() + interval '1 second'",
    "idempotency_key='00000000-0000-8000-8000-000000000009'",
    "input_ciphertext='daski:v1:other'",
    "fulfillment_deadline=now() + interval '13 hours'",
  ]) {
    if (!await rejects(`UPDATE provider_external_jobs SET ${change},revision=revision+1 WHERE task_id='task-job'`)) {
      throw new Error(`an external job's admission or start horizon changed: ${change}`);
    }
  }
  if (!await rejects("UPDATE provider_external_jobs SET last_error_code='timeout' WHERE task_id='task-job'")) {
    throw new Error("an external job changed without raising its revision");
  }
  const finish = (state, id = "task-job") => `UPDATE provider_transactions SET state='${state}',
      result='{"status":"failed","errorCode":"provider_job_not_started"}'::jsonb,
      result_hash=decode(repeat('ab',32),'hex'),completed_at=now() WHERE id='${id}'`;
  const failJob = (id = "task-job") => `UPDATE provider_external_jobs SET phase='failed',revision=revision+1,
      result_hash=decode(repeat('ab',32),'hex'),finished_at=now(),input_ciphertext=NULL,input_key_id=NULL,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE task_id='${id}'`;
  await client.query("BEGIN");
  await client.query(finish("failed"));
  if (!await rejects("COMMIT")) throw new Error("an external-job claim finished without its job");
  await client.query("BEGIN");
  await client.query(finish("failed"));
  await client.query(failJob());
  await client.query("COMMIT");
  if (!await rejects("UPDATE provider_external_jobs SET revision=revision+1 WHERE task_id='task-job'")) {
    throw new Error("a finished external job changed");
  }
  // A queued job that never started fails only once its deadline passed.
  for (const [id, key, deadline] of [
    ["task-job-early", "00000000-0000-8000-8000-000000000003", undefined],
    ["task-job-due", "00000000-0000-8000-8000-000000000004", "now() + interval '1 millisecond'"],
  ]) {
    await client.query("BEGIN");
    await client.query(jobClaim(id));
    await client.query(job(id, key, deadline));
    await client.query("COMMIT");
  }
  await client.query("SELECT pg_sleep(0.05)");
  await client.query("BEGIN");
  await client.query(finish("failed", "task-job-early"));
  const failedEarly = !await rejects(failJob("task-job-early"));
  await client.query("ROLLBACK");
  if (failedEarly) throw new Error("a queued external job failed before its deadline");
  await client.query("BEGIN");
  await client.query(finish("failed", "task-job-due"));
  await client.query(failJob("task-job-due"));
  await client.query("COMMIT");

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
    "UPDATE provider_quotes SET adapter_version='v1' WHERE false",
    "UPDATE supplier_operations SET attempts=attempts WHERE false",
    "UPDATE standard_evidence_admissions SET order_id=order_id WHERE false",
    "UPDATE provider_schema_epoch SET epoch=1",
    "INSERT INTO _migrations (name, checksum) VALUES ('legacy.sql', 'x')",
    "UPDATE provider_async_admission SET enabled=false",
    "UPDATE provider_runtime_instances SET heartbeat_at=now() WHERE false",
    "UPDATE provider_external_jobs SET revision=revision+1 WHERE false",
    "TRUNCATE rate_limit_buckets",
  ]) {
    if (!await barred(sql)) throw new Error(`an unmarked session wrote a provider table: ${sql}`);
  }
  // Async admission starts off and cannot be on without recorded evidence.
  const admission = await client.query("SELECT enabled FROM provider_async_admission");
  if (admission.rows.length !== 1 || admission.rows[0].enabled !== false) {
    throw new Error("async admission was not created off");
  }
  if (!await rejects("UPDATE provider_async_admission SET enabled=true, changed_at=now()")) {
    throw new Error("async admission was enabled without activation evidence");
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
