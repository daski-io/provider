import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { agentCardRouter } from "./agentCards/routes.js";
import { wellKnownRouter } from "./agentCards/wellKnown.js";
import { config } from "./config.js";
import { llmsTxtHandler, skillsDocsRouter } from "./docs/skillsRouter.js";
import { healthRouter, providerReady } from "./health.js";
import { logError, logInfo } from "./logger.js";
import { concurrencyBudget, configureHttpTimeouts } from "./security/httpCapacity.js";
import { installHttpSecurityBoundary } from "./security/httpBoundary.js";
import { strictJsonTransport } from "./security/jsonTransport.js";
import { makeRateLimiter } from "./security/rateLimit.js";
import {
  exceptServicing,
  forServicing,
  isServicingRequest,
  markServicingRoutes,
  respondAmbiguously,
  servicingAbuseLimiter,
} from "./security/servicingIngress.js";
import type { ProviderStandardRailConfig } from "./standardRail/config.js";
import type { DispatchDependencies } from "./standardRail/dispatch.js";
import { createStandardRailRouter } from "./standardRail/routes.js";

/**
 * Unauthenticated servicing failures tolerated per source each minute. The
 * gateway never fails authentication, so this bounds garbage floods only;
 * behind a proxy, sources are distinguished by the trusted-proxy settings.
 */
const SERVICING_FAILURES = { capacity: 120, perMinute: 120 };

let server: ReturnType<Express["listen"]> | null = null;

/**
 * Build the complete HTTP stack; `startServer` only adds the listener.
 *
 * Dispatch and its status are servicing calls for already-funded orders.
 * They keep bounded ingress, authentication and a failure-only abuse limit,
 * but skip the product-readiness gate and the purchase/global rate limits
 * that verified gateway work would otherwise spend (C01, C03).
 */
export function createApp(
  standard: ProviderStandardRailConfig,
  options: { dispatch?: DispatchDependencies } = {},
): Express {
  const app = express();
  installHttpSecurityBoundary(app);
  app.use("/health", localHealthLimiter());
  app.use("/health", healthRouter);
  markServicingRoutes(app);

  const bypassIps = config.RATE_LIMIT_BYPASS_IPS
    .split(",").map((value) => value.trim()).filter(Boolean);
  app.use(concurrencyBudget({
    maxConcurrent: config.HTTP_MAX_CONCURRENCY,
    maxConcurrentPerIp: config.HTTP_MAX_CONCURRENCY_PER_IP,
    bypassIps,
  }));
  const servicingAbuse = servicingAbuseLimiter({ ...SERVICING_FAILURES, bypassIps });
  app.use(forServicing(servicingAbuse.guard));
  app.use(exceptServicing(makeRateLimiter({
    namespace: "global",
    capacity: config.RATE_LIMIT_GLOBAL_CAPACITY,
    perMinute: config.RATE_LIMIT_GLOBAL_PER_MIN,
    bypassIps,
  })));
  app.use("/standard-rail", strictJsonTransport({
    recordServicingFailure: servicingAbuse.recordFailure,
  }));

  app.use("/.well-known", wellKnownRouter);
  app.use("/agent-cards", agentCardRouter);
  app.use("/skills", skillsDocsRouter);
  app.get("/llms.txt", llmsTxtHandler);
  const purchaseLimiter = makeRateLimiter({
    namespace: "standard-rail",
    capacity: config.RATE_LIMIT_RAIL_CAPACITY,
    perMinute: config.RATE_LIMIT_RAIL_PER_MIN,
    bypassIps,
  });
  // New sales need complete provider readiness; servicing reads never do.
  const salesReadiness = async (_req: Request, res: Response, next: NextFunction) => {
    if (!(await providerReady())) {
      res.setHeader("Retry-After", "30");
      res.status(503).json({ error: "provider_not_ready" });
      return;
    }
    next();
  };
  app.use(["/standard-rail/outcomes", "/standard-rail/quote"], salesReadiness, purchaseLimiter);
  app.use("/standard-rail", createStandardRailRouter(config, standard, {
    recordServicingFailure: servicingAbuse.recordFailure,
    dispatch: options.dispatch,
  }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown; type?: unknown }).status;
    const clientError = typeof status === "number" && status >= 400 && status < 500
      && typeof (error as { type?: unknown }).type === "string";
    logError("HTTP request failed", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      ...(clientError ? { status } : {}),
    });
    // Middleware refusals are answered where they happen; an error that
    // escapes a servicing handler may follow an admission, so it is ambiguous.
    if (isServicingRequest(req)) {
      respondAmbiguously(res);
      return;
    }
    if (res.headersSent) return;
    if (clientError) {
      res.status(status as number).json({ error: status === 413 ? "payload_too_large" : "invalid_json" });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}

export async function startServer(standard: ProviderStandardRailConfig): Promise<void> {
  const app = createApp(standard);
  await new Promise<void>((resolve, reject) => {
    const listening = config.CHAIN_MODE === "mock"
      ? app.listen(config.PORT, "127.0.0.1")
      : app.listen(config.PORT);
    configureHttpTimeouts(listening);
    listening.once("error", reject);
    listening.once("listening", () => {
      logInfo("Server listening", { port: config.PORT });
      resolve();
    });
    server = listening;
  });
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

function localHealthLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.socket.remoteAddress ?? "unknown";
    const bucket = buckets.get(key);
    const current = !bucket || bucket.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : bucket;
    current.count += 1;
    buckets.set(key, current);
    if (current.count > config.RATE_LIMIT_HEALTH_CAPACITY) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1_000)));
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    if (buckets.size > 10_000) {
      for (const [ip, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(ip);
      }
    }
    next();
  };
}
