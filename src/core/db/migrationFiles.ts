import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One migration this build ships, with the checksum the ledger records for it. */
export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** This build's migrations in apply order (`src/core/db/migrations`, copied beside the build). */
export function buildMigrations(): MigrationFile[] {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(directory, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}
