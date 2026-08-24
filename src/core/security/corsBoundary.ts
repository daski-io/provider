import cors, { type CorsOptions } from "cors";
import type { Express, NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logWarn } from "../logger.js";

/** Decides whether a request's `Origin` may talk to this provider at all. */
export type OriginPolicy = (origin: string | undefined) => boolean;

/**
 * Install the browser-origin boundary: one policy, two middlewares.
 *
 *  1. a guard that answers a disallowed Origin with `403 origin_not_allowed`
 *  2. the CORS layer, which emits `Access-Control-*` for the allowed ones
 *
 * Mount order matters and is preserved from the bare `cors()` call this
 * replaced: it sits after the health routes and the global rate limiter, so
 * liveness probes and rate-limit accounting are unaffected.
 */
export function installCorsBoundary(app: Express): void {
  const isAllowed = buildOriginPolicy();
  app.use(rejectDisallowedOrigin(isAllowed));
  app.use(cors(buildCorsOptions(isAllowed)));
}

/**
 * Same-origin (Origin matches BASE_URL) and the explicit CORS_ORIGINS
 * allowlist are permitted. Server-to-server callers (gateway facilitator,
 * MCP buyers, ops tooling) don't send Origin — those requests skip the
 * allowlist and pass through. Same-origin is auto-allowed because browsers
 * send the Origin header on POSTs even when source = destination (e.g. the
 * admin UI's login form posts back to its own host); blocking those would
 * break the UI without any cross-origin attack surface to guard against.
 *
 * Reads config once, at construction — callers install the boundary at boot.
 */
export function buildOriginPolicy(): OriginPolicy {
  const allowlist = config.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let baseOrigin: string | null = null;
  try {
    baseOrigin = new URL(config.BASE_URL).origin;
  } catch {
    // Misconfigured BASE_URL → fall back to allowlist-only.
  }
  return (origin) => {
    if (!origin) return true;
    if (baseOrigin && origin === baseOrigin) return true;
    return allowlist.includes(origin);
  };
}

function rejectDisallowedOrigin(isAllowed: OriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // An absent header reads as undefined; a browser's opaque origin arrives
    // as the literal string "null". Both are handled by the policy.
    const origin = req.get("origin");
    if (isAllowed(origin)) {
      next();
      return;
    }
    // A rejected Origin is a client condition, not a server fault. The policy
    // used to hand `cb` an Error, so the error handler answered
    // `500 internal_error` and logged at error level — which made a cross-site
    // attempt indistinguishable from a crash in logs and alerting, and let any
    // browser sending an opaque `Origin: null` spike the error rate. Reject
    // explicitly and log at warn: same fail-closed outcome, honest signal.
    logWarn("origin rejected", { origin, method: req.method, path: req.path });
    res.status(403).json({ error: "origin_not_allowed" });
  };
}

function buildCorsOptions(isAllowed: OriginPolicy): CorsOptions {
  return {
    // The guard above already rejected disallowed origins, so this only ever
    // sees allowed ones. Mirroring the same predicate anyway means
    // Access-Control-Allow-Origin can never be emitted for a disallowed origin
    // even if the two are reordered — and `cb(null, false)` omits the header
    // rather than throwing, so no path here can produce a 500.
    //
    // This is NOT the rejection: `cb(null, false)` only withholds the header
    // and lets the request continue to the route (CORS is browser-enforced by
    // design). Deleting the guard above and relying on `false` alone would
    // serve every disallowed origin a 200 — verified by removing it and
    // watching test/corsBoundary.test.ts fail 403→200. The guard is what
    // keeps this boundary fail-closed for non-browser clients.
    origin: (origin, cb) => cb(null, isAllowed(origin ?? undefined)),
    credentials: false,
  };
}
