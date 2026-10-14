import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";

/**
 * PostgreSQL-backed tests run only against an explicit disposable loopback
 * database named by DATABASE_URL_TEST. Without it they are skipped, so the
 * ordinary unit suite stays offline. Each suite creates and drops its own
 * database (and roles, when it needs them) so suites never share state.
 */
export const databaseTestUrl = process.env.DATABASE_URL_TEST?.trim() || null;

export const describePostgres: ReturnType<typeof describe.skipIf> =
  describe.skipIf(!databaseTestUrl);

function adminUrl(): URL {
  if (!databaseTestUrl) throw new Error("DATABASE_URL_TEST is required");
  const url = new URL(databaseTestUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    || !database
    || ["postgres", "template0", "template1"].includes(database)
  ) {
    throw new Error("PostgreSQL tests require an explicit loopback disposable database");
  }
  return url;
}

export function uniqueName(prefix: string): string {
  const name = `${prefix}_${randomBytes(8).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(name)) throw new Error("unsafe test identifier");
  return name;
}

export function databaseUrl(database: string, role?: { name: string; password: string }): string {
  const url = adminUrl();
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.toString();
}

export async function withAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl().toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface DisposableDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Create a fresh database, optionally owned by an existing test role. */
export async function createDisposableDatabase(
  prefix: string,
  owner?: string,
): Promise<DisposableDatabase> {
  const name = uniqueName(prefix);
  await withAdmin((client) => client.query(
    `CREATE DATABASE "${name}"${owner ? ` OWNER "${owner}"` : ""}`,
  ));
  return {
    name,
    url: databaseUrl(name),
    drop: () => withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }),
  };
}

export interface DisposableRole {
  name: string;
  password: string;
  drop(): Promise<void>;
}

/** Create an unprivileged login role like a production principal. */
export async function createDisposableRole(prefix: string): Promise<DisposableRole> {
  const name = uniqueName(prefix);
  const password = randomBytes(16).toString("hex");
  await withAdmin((client) => client.query(
    `CREATE ROLE "${name}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  ));
  return {
    name,
    password,
    drop: () => withAdmin(async (client) => {
      await client.query(`DROP ROLE IF EXISTS "${name}"`);
    }),
  };
}
