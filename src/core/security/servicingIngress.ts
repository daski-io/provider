import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { logWarn } from "../logger.js";
import { LIFECYCLE_UNAVAILABLE_BODY } from "../standardRail/lifecycleErrors.js";
import {
  consumeRateLimitToken,
  hasRateLimitToken,
  isIpInRanges,
  requestClientIp,
} from "./rateLimit.js";

type ServicingKind = "dispatch" | "status" | "lifecycle";
const servicing = new WeakMap<Request, ServicingKind>();

/**
 * Mark gateway servicing calls for already-funded orders (the dispatch, its
 * reconciliation status and authenticated buyer lifecycle reads) using
 * Express's own route matching, so every request those handlers serve is
 * classified the same way, and nothing else. Must be installed before any
 * middleware that consults the classification.
 */
export function markServicingRoutes(app: Express): void {
  const mark = (kind: ServicingKind): RequestHandler => (req, _res, next) => {
    servicing.set(req, kind);
    next();
  };
  app.post("/standard-rail/dispatch/status", mark("status"));
  app.post("/standard-rail/dispatch", mark("dispatch"));
  app.post("/standard-rail/lifecycle", mark("lifecycle"));
}

export const servicingPath = (req: Request): ServicingKind | null => servicing.get(req) ?? null;
export const isServicingRequest = (req: Request): boolean => servicing.has(req);

export const forServicing = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => isServicingRequest(req) ? handler(req, res, next) : next();

export const exceptServicing = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => isServicingRequest(req) ? next() : handler(req, res, next);

/**
 * The deliberately ambiguous transport answer (C03): an empty-body 503 makes
 * the gateway status-poll the original dispatch hash instead of recording a
 * refusal and sending a new envelope. Handlers use it whenever admission
 * exists, may exist, or cannot be checked; a middleware refusal of a request
 * that never reached a handler is a definite refusal and stays JSON.
 */
export function respondAmbiguously(res: Response): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.removeHeader("Content-Type");
  res.setHeader("Retry-After", "10");
  res.setHeader("Cache-Control", "no-store");
  res.status(503).end();
}

/**
 * The named temporary lifecycle refusal (G02): exactly
 * `503 {"error": "lifecycle_unavailable"}`, which the gateway shows the buyer
 * as retryable. Lifecycle ambiguity has no dispatch semantics, so a read the
 * provider cannot serve right now is named, never an empty or 500 answer.
 */
export function respondLifecycleUnavailable(res: Response): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.setHeader("Retry-After", "10");
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json(LIFECYCLE_UNAVAILABLE_BODY);
}

/**
 * Lifecycle calls carry buyer-chosen content the gateway forwards under its
 * own grant, so they never share the budget that dispatch and status, the
 * paid-order path, depend on.
 */
const namespaceOf = (req: Request) =>
  servicingPath(req) === "lifecycle" ? "servicing-failures:lifecycle" : "servicing-failures";

/**
 * Abuse limit for servicing calls that never charges verified gateway work:
 * only requests that fail before authentication (malformed, wrong domain,
 * bad signature, and for dispatch and status transport faults) spend a
 * token from a PostgreSQL bucket per source, and the guard only reads it. A
 * source with no tokens left gets a JSON 429 before parsing; it never reached
 * a handler, so nothing was admitted. A lifecycle read uses its own bucket and
 * is told the named lifecycle_unavailable instead, which the gateway relays as
 * retryable. A store failure fails open: authentication still applies.
 */
export function servicingAbuseLimiter(args: {
  capacity: number;
  perMinute: number;
  bypassIps: string[];
}) {
  return {
    async guard(req: Request, res: Response, next: NextFunction): Promise<void> {
      const ip = requestClientIp(req);
      if (isIpInRanges(ip, args.bypassIps)) return next();
      let allowed = true;
      try {
        allowed = await hasRateLimitToken(namespaceOf(req), ip, args.capacity, args.perMinute);
      } catch {
        allowed = true;
      }
      if (allowed) return next();
      if (servicingPath(req) === "lifecycle") {
        respondLifecycleUnavailable(res);
        return;
      }
      const retryAfter = Math.max(1, Math.ceil(60 / args.perMinute));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "rate_limit_exceeded", retryAfter });
    },
    recordFailure(req: Request): void {
      const ip = requestClientIp(req);
      if (isIpInRanges(ip, args.bypassIps)) return;
      void consumeRateLimitToken(namespaceOf(req), ip, args.capacity, args.perMinute).catch(() => {
        logWarn("Servicing failure could not be recorded");
      });
    },
  };
}
