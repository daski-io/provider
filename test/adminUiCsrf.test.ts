import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireAdminUiAuth } from "../src/core/admin/ui/authMiddleware.js";
import { expectedSiweUri } from "../src/core/auth/siwe.js";

// CSRF Origin check on the cookie-authed admin UI (Phase 2). State-changing
// requests must carry an Origin equal to our host; the cookie is also
// SameSite=Lax, but this is enforced defense-in-depth. The accepted origin is
// derived from the same configured BASE_URL used by SIWE verification.
//
// SCOPE: these are unit tests of the middleware against a mocked `res`, so
// they describe what requireAdminUiAuth decides — NOT what a client receives.
// The cross-origin cases below are shadowed end-to-end: the CORS boundary
// (src/core/security/corsBoundary.ts) rejects a disallowed origin with
// `origin_not_allowed` before this middleware runs, so the wire never carries
// `csrf_origin_mismatch` for them. They are kept because this check is a real
// second layer — it is what rejects an Origin-less request, which CORS
// deliberately allows through — and because it must keep failing closed if the
// allowlist is ever widened. For the responses a client actually gets, see
// test/corsBoundary.test.ts, which drives a real express stack over a socket.
// Asserting a status here that the HTTP surface could never return is exactly
// what hid the 500-instead-of-403 defect.

const GOOD_ORIGIN = expectedSiweUri();

function makeReq(opts: {
  method: string;
  path: string;
  origin?: string;
  cookie?: string;
}): Request {
  return {
    method: opts.method,
    path: opts.path,
    headers: { cookie: opts.cookie },
    get(name: string) {
      if (name.toLowerCase() === "origin") return opts.origin;
      return undefined;
    },
  } as unknown as Request;
}

function makeRes() {
  let statusCode: number | undefined;
  let body: unknown;
  let redirectedTo: string | undefined;
  const res = {
    status(c: number) {
      statusCode = c;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
    redirect(loc: string) {
      redirectedTo = loc;
      return this;
    },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    body: () => body,
    redirect: () => redirectedTo,
  };
}

describe("requireAdminUiAuth CSRF Origin check", () => {
  it("rejects a state-changing POST with no Origin", async () => {
    const req = makeReq({ method: "POST", path: "/wallet" });
    const { res, status, body } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).toBe(403);
    expect(body()).toEqual({ error: "csrf_origin_mismatch" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a state-changing POST from an opaque Origin", async () => {
    const req = makeReq({ method: "POST", path: "/wallet", origin: "null" });
    const { res, status, body } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).toBe(403);
    expect(body()).toEqual({ error: "csrf_origin_mismatch" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a POST whose Origin is a different site", async () => {
    const req = makeReq({ method: "POST", path: "/wallet", origin: "https://evil.example.com" });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes the CSRF check for a same-host POST (then fails auth → login redirect)", async () => {
    const req = makeReq({ method: "POST", path: "/wallet", origin: GOOD_ORIGIN });
    const { res, status, redirect } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).not.toBe(403); // CSRF passed
    expect(redirect()).toBe("/admin/ui/login"); // no cookie → auth redirect
    expect(next).not.toHaveBeenCalled();
  });

  it("does not apply the Origin check to safe GET requests", async () => {
    const req = makeReq({ method: "GET", path: "/wallet" });
    const { res, status, redirect } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).not.toBe(403);
    expect(redirect()).toBe("/admin/ui/login"); // no cookie → auth redirect
  });

  it("exempts the public login/verify POST from the Origin check", async () => {
    const req = makeReq({ method: "POST", path: "/login/verify" });
    const { res, status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdminUiAuth(req, res, next);
    expect(status()).not.toBe(403);
    expect(next).toHaveBeenCalledOnce(); // public path → passes through
  });
});
