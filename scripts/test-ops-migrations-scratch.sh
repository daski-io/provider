#!/usr/bin/env bash
# Exercise scripts/run-pending-migrations.mjs against a THROWAWAY database
# (local convenience; CI covers migrations via its own service container).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source ./.env
set +a

SCRATCH="daski_ops_$(date +%s)"

node <<NODE
const { Client } = require("pg");
(async () => {
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query('CREATE DATABASE "' + "$SCRATCH" + '"');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
NODE

NEWURL=$(node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = "/" + process.argv[1]; console.log(u.toString());' "$SCRATCH")

set +e
node scripts/run-pending-migrations.mjs "$NEWURL"
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
})().catch((e) => console.error(e.message));
NODE

exit $EC
