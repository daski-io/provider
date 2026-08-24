// Apply any pending CORE + SERVICE migrations using the SAME runners the
// app executes at boot — advisory locks, checksums, and the per-service
// _service_migrations ledger included (audit 4.1). The old version of this
// script re-implemented a lock-free, checksum-free core-only loop, so an
// operator using it silently bypassed every integrity guarantee the boot
// runner enforces and could not catch up service schemas at all.
//
// Requires a build first (`npm run build`) — the dist/ runners are the
// exact code the deployed app runs.
//
// usage: node scripts/run-pending-migrations.mjs [DATABASE_URL]
//        (falls back to $DATABASE_URL when the argument is omitted)

const argUrl = process.argv[2];
if (argUrl) process.env.DATABASE_URL = argUrl;
if (!process.env.DATABASE_URL) {
  console.error("usage: node scripts/run-pending-migrations.mjs <DATABASE_URL>");
  process.exit(1);
}

const { runMigrations, closeMigrationPool, pool } = await import("../dist/core/db/pool.js");
const { registerService } = await import("../dist/core/serviceRegistry/registry.js");
const { providerServices } = await import("../dist/providerServices.js");

try {
  await runMigrations();
  console.log(JSON.stringify({ step: "core-migrations", status: "applied" }));

  // Service registration runs each module's service migrations through the
  // locked, checksummed service runner (and re-seeds manifest defaults the
  // same way a boot would).
  for (const service of providerServices) {
    await registerService(service);
    console.log(
      JSON.stringify({ step: `service-migrations:${service.manifest.slug}`, status: "applied" }),
    );
  }
} catch (err) {
  console.error(JSON.stringify({ status: "failed", error: err.message }));
  process.exitCode = 2;
} finally {
  await closeMigrationPool().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
