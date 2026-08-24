import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../src/core/db/pool.js", () => ({ pool: { query } }));

import {
  createSession,
  getActiveSession,
} from "../src/core/db/queries/sessions.js";

const WALLET = `0x${"ab".repeat(20)}`;

beforeEach(() => query.mockReset());

describe("opaque admin sessions", () => {
  it("returns a high-entropy bearer while storing only its SHA-256 hash", async () => {
    query.mockImplementation(async () => ({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          token_hash: Buffer.alloc(32),
          user_label: "0xabc",
          created_at: new Date(),
          expires_at: new Date(Date.now() + 60 * 60_000),
          last_seen_at: new Date(),
        },
      ],
    }));
    const created = await createSession(
      WALLET,
      new Date(Date.now() + 60 * 60_000),
    );
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.token).not.toBe(created.session.id);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[0]).toEqual(
      createHash("sha256").update(created.token, "utf8").digest(),
    );
    expect(Buffer.isBuffer(params[0])).toBe(true);
    expect((params[0] as Buffer).toString("utf8")).not.toContain(created.token);
  });

  it("does not accept a leaked database session UUID as a bearer", async () => {
    expect(await getActiveSession("11111111-1111-1111-1111-111111111111")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed for malformed stored hashes and enforces the lifetime bound on lookup", async () => {
    const token = Buffer.alloc(32, 9).toString("base64url");
    query.mockResolvedValue({
      rows: [{
        id: "11111111-1111-1111-1111-111111111111",
        token_hash: Buffer.alloc(31),
        user_label: WALLET,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
        last_seen_at: new Date(),
      }],
    });
    await expect(getActiveSession(token)).resolves.toBeNull();
    expect(String(query.mock.calls[0]![0])).toContain(
      "expires_at <= created_at + interval '24 hours'",
    );
  });

  it("rejects unbounded lifetimes", async () => {
    await expect(
      createSession(WALLET, new Date(Date.now() + 25 * 60 * 60_000)),
    ).rejects.toThrow(/24 hours/);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects malformed wallet labels before persistence", async () => {
    await expect(
      createSession("operator", new Date(Date.now() + 60_000)),
    ).rejects.toThrow(/20-byte hexadecimal address/);
    expect(query).not.toHaveBeenCalled();
  });
});
