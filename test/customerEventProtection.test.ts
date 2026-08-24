import { describe, expect, it, vi } from "vitest";
import {
  decryptCustomerEvent,
  recordMandatoryAudit,
  type EventRow,
} from "../src/core/events/emitter.js";
import type { Queryable } from "../src/core/db/queryable.js";

describe("atomic customer-event protection", () => {
  it("never passes the buyer message sentinel to PostgreSQL in plaintext", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
      command: "INSERT",
      oid: 0,
      rows: [],
      fields: [],
      rowCount: 1,
    }));
    const sentinel = "CUSTOMER_EVENT_PLAINTEXT_SENTINEL@example.test";
    await recordMandatoryAudit({
      query: query as unknown as Queryable["query"],
    }, {
      transactionId: "task-1",
      serviceId: "service-1",
      source: "adapter",
      type: "transaction.message.user",
      message: `Execute create-item for ${sentinel}`,
      payload: { role: "user", content: sentinel },
    });
    const values = query.mock.calls[0]?.[1] ?? [];
    expect(JSON.stringify(values)).not.toContain(sentinel);
    expect(values[7]).toBe("Buyer message received");

    const row = {
      id: values[0],
      transaction_id: "task-1",
      asset_id: null,
      service_id: "service-1",
      source: "adapter",
      severity: "info",
      type: "transaction.message.user",
      message: values[7],
      payload: JSON.parse(String(values[8])),
      actor: null,
      created_at: new Date(),
    } as EventRow;
    expect(decryptCustomerEvent(row)).toMatchObject({
      message: expect.stringContaining(sentinel),
      payload: { content: sentinel },
    });
  });
});
