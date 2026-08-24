import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Auth middleware factory for /admin/* routes. Fails closed:
 *   - Missing/empty expected token → 500 (zod normally rejects at boot,
 *     this is a defense-in-depth check for misconfigured test harnesses).
 *   - Missing Authorization header or wrong scheme → 401.
 *   - Wrong token → 401 (timing-safe compare so response time doesn't
 *     leak token bytes).
 *
 * The factory form (`getExpected: () => string | undefined`) is what the
 * router mount uses in prod; it defers reading the token until request
 * time, while the production config remains a boot-time snapshot. Tests pass
 * a closure over a literal so they don't have to import `config.js` (which
 * parses env at module load).
 */
export function makeRequireAdminAuth(
  getExpected: () => string | undefined,
) {
  return function requireAdminAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const expected = getExpected();
    if (!expected) {
      res.status(500).json({ error: "ADMIN_TOKEN not configured" });
      return;
    }

    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const provided = Buffer.from(match[1]);
    const expectedBuf = Buffer.from(expected);
    // timingSafeEqual requires equal-length buffers. Short-circuit on length
    // mismatch — this leaks *length* (already encoded into 401 either way)
    // but not the token content.
    if (
      provided.length !== expectedBuf.length ||
      !timingSafeEqual(provided, expectedBuf)
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}
