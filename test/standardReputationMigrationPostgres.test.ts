import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("standard reputation baseline against PostgreSQL", () => {
  it("admits the standard outcome purpose without reopening retired writes", async () => {
    const schema = `provider_reputation_${randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE provider_chain_writes (
        id UUID PRIMARY KEY,
        purpose TEXT NOT NULL,
        CONSTRAINT provider_chain_writes_purpose_check CHECK (purpose IN (
          'reputation_attestation','refund_approval','refund','service_registration',
          'service_uri_update','nonce_cancel','standard_reputation_outcome'
        ))
      )`);
      await expect(client.query(
        "INSERT INTO provider_chain_writes (id,purpose) VALUES ($1,$2)",
        [randomUUID(), "standard_reputation_outcome"],
      )).resolves.toBeDefined();
      await expect(client.query(
        "INSERT INTO provider_chain_writes (id,purpose) VALUES ($1,$2)",
        [randomUUID(), "legacy_payment"],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET search_path TO public").catch(() => undefined);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
