import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("asset-action terminal transaction migration against PostgreSQL", () => {
  it("repairs only working transactions whose linked action is canceled or expired", async () => {
    const schema = `provider_action_lifecycle_${randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        asset_id UUID,
        service_id UUID NOT NULL,
        status TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        version BIGINT NOT NULL DEFAULT 1,
        standard_action_execution_id BYTEA UNIQUE
      )`);
      await client.query(`CREATE TABLE standard_asset_action_executions (
        execution_id BYTEA PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await client.query(`CREATE TABLE events (
        id UUID PRIMARY KEY,
        transaction_id TEXT,
        asset_id UUID,
        service_id UUID,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

      await client.query(`INSERT INTO standard_asset_action_executions
        (execution_id,state,updated_at)
        VALUES
          (decode(repeat('11',32),'hex'),'canceled','2026-08-19T12:00:00Z'),
          (decode(repeat('22',32),'hex'),'expired','2026-08-20T12:00:00Z'),
          (decode(repeat('33',32),'hex'),'staged','2026-08-21T12:00:00Z'),
          (decode(repeat('44',32),'hex'),'canceled','2026-08-18T12:00:00Z')`);
      await client.query(`INSERT INTO transactions
        (id,service_id,status,metadata,completed_at,version,standard_action_execution_id)
        VALUES
          ('canceled-working','11111111-1111-4111-8111-111111111111','working',
            '{"existing":true}',NULL,1,decode(repeat('11',32),'hex')),
          ('expired-working','11111111-1111-4111-8111-111111111111','working',
            '{}',NULL,4,decode(repeat('22',32),'hex')),
          ('staged-working','11111111-1111-4111-8111-111111111111','working',
            '{}',NULL,1,decode(repeat('33',32),'hex')),
          ('already-completed','11111111-1111-4111-8111-111111111111','completed',
            '{}','2026-08-18T11:00:00Z',7,decode(repeat('44',32),'hex'))`);

      const migration = readFileSync(
        new URL(
          "../src/core/db/migrations/047_asset_action_terminal_transactions.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(migration);

      const transactions = await client.query<{
        id: string;
        status: string;
        metadata: Record<string, unknown>;
        completed_at: Date | null;
        version: string;
      }>(
        `SELECT id,status,metadata,completed_at,version::text
           FROM transactions ORDER BY id`,
      );
      const byId = new Map(transactions.rows.map((row) => [row.id, row]));

      expect(byId.get("canceled-working")).toMatchObject({
        status: "canceled",
        version: "2",
        metadata: {
          existing: true,
          asset_action_state: "canceled",
          asset_action_terminal_reason: "wallet_canceled",
        },
      });
      expect(byId.get("canceled-working")?.completed_at).toEqual(
        new Date("2026-08-19T12:00:00Z"),
      );
      expect(byId.get("expired-working")).toMatchObject({
        status: "canceled",
        version: "5",
        metadata: {
          asset_action_state: "expired",
          asset_action_terminal_reason: "confirmation_expired",
        },
      });
      expect(byId.get("expired-working")?.completed_at).toEqual(
        new Date("2026-08-20T12:00:00Z"),
      );
      expect(byId.get("staged-working")).toMatchObject({
        status: "working",
        version: "1",
        completed_at: null,
      });
      expect(byId.get("already-completed")).toMatchObject({
        status: "completed",
        version: "7",
      });

      const events = await client.query<{
        transaction_id: string;
        type: string;
        payload: Record<string, unknown>;
        actor: string;
      }>(
        `SELECT transaction_id,type,payload,actor
           FROM events ORDER BY transaction_id`,
      );
      expect(events.rows).toHaveLength(2);
      expect(events.rows[0]).toMatchObject({
        transaction_id: "canceled-working",
        type: "asset_action.canceled",
        actor: "system:migration:047",
        payload: {
          actionState: "canceled",
          reason: "wallet_canceled",
          transactionStatus: "canceled",
          repairedByMigration: true,
        },
      });
      expect(events.rows[1]).toMatchObject({
        transaction_id: "expired-working",
        type: "asset_action.expired",
        actor: "system:migration:047",
        payload: {
          actionState: "expired",
          reason: "confirmation_expired",
          transactionStatus: "canceled",
          repairedByMigration: true,
        },
      });
    } finally {
      await client.query("SET search_path TO public").catch(() => undefined);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
