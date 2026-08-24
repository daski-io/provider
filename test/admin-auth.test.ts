import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRequireAdminAuth } from "../src/core/admin/auth.js";

/**
 * Unit tests for the /admin/* auth middleware. We test the factory form
 * directly so the suite does not need a real Postgres / config bootstrap.
 */

function makeReq(headers: Record<string, string> = {}): Request {
  return {
    get(name: string) {
      // express's req.get is case-insensitive
      const lower = name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) return headers[k];
      }
      return undefined;
    },
  } as unknown as Request;
}

function makeRes(): { res: Response; status: (c?: number) => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => body };
}

const TOKEN = "s3cret-admin-token-of-sufficient-length";

describe("requireAdminAuth", () => {
  it("passes through when the Bearer token matches", () => {
    const mw = makeRequireAdminAuth(() => TOKEN);
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBeUndefined();
  });

  it("rejects with 401 when the Authorization header is missing", () => {
    const mw = makeRequireAdminAuth(() => TOKEN);
    const req = makeReq({});
    const { res, status, body } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
    expect(body()).toEqual({ error: "unauthorized" });
  });

  it("rejects with 401 when the scheme is not Bearer", () => {
    const mw = makeRequireAdminAuth(() => TOKEN);
    const req = makeReq({ authorization: `Basic ${TOKEN}` });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it("rejects with 401 when the token is wrong (same length)", () => {
    const mw = makeRequireAdminAuth(() => TOKEN);
    // Same length as TOKEN so the length short-circuit doesn't fire — this
    // exercises the timingSafeEqual branch specifically.
    const wrong = "X".repeat(TOKEN.length);
    const req = makeReq({ authorization: `Bearer ${wrong}` });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it("rejects with 401 when the token is wrong (different length)", () => {
    const mw = makeRequireAdminAuth(() => TOKEN);
    const req = makeReq({ authorization: "Bearer short" });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it("returns 500 when the expected token is not configured", () => {
    const mw = makeRequireAdminAuth(() => undefined);
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const { res, status, body } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(500);
    expect(body()).toEqual({ error: "ADMIN_TOKEN not configured" });
  });
});
