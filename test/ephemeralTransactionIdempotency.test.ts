import { describe, expect, it } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";
import {
  createOrGetEphemeralTransaction,
  EphemeralRequestConflictError,
  type TransactionRow,
} from "../src/core/db/queries/transactions.js";

const requestHash = Buffer.alloc(32, 1);
const requestIdHash = Buffer.alloc(32, 2);
const existing = {
  id: "task-existing",
  customer_id: "customer-0",
  asset_id: null,
  service_id: "service-1",
  skill_id: "get-pricing",
  service_ref: null,
  status: "completed",
  contact_email: null,
  metadata: {},
  created_at: new Date(),
  updated_at: new Date(),
  completed_at: new Date(),
  version: "1",
  canonical_request_hash: requestHash,
  retention_class: "ephemeral",
  expires_at: new Date(Date.now() + 60_000),
  request_id_hash: requestIdHash,
  accepted_envelope_message_id_hash: null,
} as TransactionRow;

function args() {
  return {
    id: "task-proposed",
    customer_id: "customer-0",
    service_id: "service-1",
    skill_id: "get-pricing",
    expires_at: new Date(Date.now() + 60_000),
    request_id_hash: requestIdHash,
    canonical_request_hash: requestHash,
  };
}

describe("ephemeral transaction idempotency", () => {
  it("returns the existing task after a matching request conflict", async () => {
    let calls = 0;
    const db: Queryable = {
      async query() {
        calls++;
        return calls === 1
          ? { rows: [], rowCount: 0 } as never
          : { rows: [existing], rowCount: 1 } as never;
      },
    };
    await expect(createOrGetEphemeralTransaction(args(), db)).resolves.toEqual({
      transaction: existing,
      created: false,
    });
    expect(calls).toBe(2);
  });

  it("rejects reuse of a message id with different request data", async () => {
    let calls = 0;
    const db: Queryable = {
      async query() {
        calls++;
        return calls === 1
          ? { rows: [], rowCount: 0 } as never
          : {
              rows: [{
                ...existing,
                canonical_request_hash: Buffer.alloc(32, 9),
              }],
              rowCount: 1,
            } as never;
      },
    };
    await expect(
      createOrGetEphemeralTransaction(args(), db),
    ).rejects.toBeInstanceOf(EphemeralRequestConflictError);
  });
});
