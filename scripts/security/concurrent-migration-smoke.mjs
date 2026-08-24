import { spawn } from "node:child_process";
import pg from "pg";

if (process.env.NODE_ENV !== "test") throw new Error("migration concurrency smoke is test-only");
const base = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(base.hostname)) {
  throw new Error("migration concurrency smoke requires a loopback PostgreSQL server");
}
const database = "daski_migration_concurrency_ci";
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(base);
targetUrl.pathname = `/${database}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });

function runMigration() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/security/migration-smoke.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: targetUrl.toString(),
        MIGRATION_DATABASE_URL: targetUrl.toString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  const concurrent = await Promise.all([runMigration(), runMigration()]);
  if (concurrent.some((result) => result.code !== 0)) {
    throw new Error(`concurrent migration failed: ${concurrent.map((r) => r.output).join("\n")}`);
  }
  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    await target.query("UPDATE _migrations SET checksum = repeat('0', 64) WHERE name = (SELECT min(name) FROM _migrations)");
  } finally {
    await target.end();
  }
  const changed = await runMigration();
  if (changed.code === 0 || !/checksum changed/i.test(changed.output)) {
    throw new Error("changed applied migration was not rejected");
  }
  process.stdout.write("concurrent/checksummed migration smoke passed\n");
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
