import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isIpInRanges, requestClientIp } from "./rateLimit.js";

const SERVICING_PATHS = new Set(["/standard-rail/dispatch", "/standard-rail/dispatch/status"]);
const ABUSE_WINDOW_MS = 60_000;

/**
 * Gateway servicing calls for already-funded orders: the dispatch and its
 * reconciliation status. Matching mirrors Express routing (case-insensitive,
 * optional trailing slash) so no variant can reach those handlers unclassified.
 */
export function isServicingRequest(req: Request): boolean {
  return servicingPath(req) !== null;
}

export function servicingPath(req: Request): "dispatch" | "status" | null {
  if (req.method !== "POST") return null;
  const url = req.originalUrl ?? req.url ?? "";
  const path = (url.split("?", 1)[0] ?? "").toLowerCase().replace(/\/+$/, "");
  if (!SERVICING_PATHS.has(path)) return null;
  return path.endsWith("/status") ? "status" : "dispatch";
}

/**
 * The deliberately ambiguous transport answer (C03): an empty-body 503 makes
 * the gateway status-poll the original dispatch hash instead of recording a
 * refusal and sending a new envelope. Used whenever admission exists, may
 * exist, or cannot be checked.
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

/** Middleware refusal: JSON for ordinary routes, never a JSON `error` for servicing calls. */
export function rejectRequest(req: Request, res: Response, status: number, error: string): void {
  if (isServicingRequest(req)) {
    respondAmbiguously(res);
    return;
  }
  res.status(status).json({ error });
}

export const forServicing = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => isServicingRequest(req) ? handler(req, res, next) : next();

export const exceptServicing = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => isServicingRequest(req) ? next() : handler(req, res, next);

/**
 * Abuse limit for servicing calls that never charges verified gateway work.
 * Only requests that fail before authentication (malformed, wrong domain,
 * bad signature) count; a source over the limit receives the ambiguous
 * answer until its window resets. Process-local by design: it guards no
 * money or task state, and verified reads write nothing.
 */
export function servicingAbuseLimiter(args: { maxFailuresPerMinute: number; bypassIps: string[] }) {
  const buckets = new Map<string, { failures: number; resetAt: number }>();
  const live = (ip: string, now: number) => {
    const bucket = buckets.get(ip);
    return bucket && bucket.resetAt > now ? bucket : null;
  };
  return {
    guard(req: Request, res: Response, next: NextFunction): void {
      const ip = requestClientIp(req);
      const bucket = live(ip, Date.now());
      if (
        bucket && bucket.failures >= args.maxFailuresPerMinute
        && !isIpInRanges(ip, args.bypassIps)
      ) {
        respondAmbiguously(res);
        return;
      }
      next();
    },
    recordFailure(req: Request): void {
      const ip = requestClientIp(req);
      if (isIpInRanges(ip, args.bypassIps)) return;
      const now = Date.now();
      const bucket = live(ip, now) ?? { failures: 0, resetAt: now + ABUSE_WINDOW_MS };
      bucket.failures += 1;
      buckets.set(ip, bucket);
      if (buckets.size > 10_000) {
        for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
      }
    },
  };
}
