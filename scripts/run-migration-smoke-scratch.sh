#!/usr/bin/env bash
# Run the migration smoke against a THROWAWAY database derived from the
# .env DATABASE_URL credentials, then drop it. Local convenience wrapper —
# CI provisions its own service container instead.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source ./.env
set +a

SCRATCH="daski_smoke_$(date +%s)"

node <<NODE
const { Client } = require("pg");
(async () => {
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query('CREATE DATABASE "' + "$SCRATCH" + '"');
  await c.end();
  console.log("created scratch db $SCRATCH");
})().catch((e) => { console.error(e.message); process.exit(1); });
NODE

NEWURL=$(node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = "/" + process.argv[1]; console.log(u.toString());' "$SCRATCH")

set +e
DATABASE_URL="$NEWURL" node scripts/security/migration-smoke.mjs
EC=$?
set -e

node <<NODE
const { Client } = require("pg");
(async () => {
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query('DROP DATABASE IF EXISTS "' + "$SCRATCH" + '" WITH (FORCE)');
  await c.end();
  console.log("dropped scratch db $SCRATCH");
})().catch((e) => console.error(e.message));
NODE

exit $EC
