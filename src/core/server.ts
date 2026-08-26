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
import { makeRateLimiter } from "./security/rateLimit.js";
import { assertNoDuplicateJsonKeys } from "./standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "./standardRail/config.js";
import { createStandardRailRouter } from "./standardRail/routes.js";

let server: ReturnType<Express["listen"]> | null = null;

export async function startServer(standard: ProviderStandardRailConfig): Promise<void> {
  const app = express();
  installHttpSecurityBoundary(app);
  app.use("/health", localHealthLimiter());
  app.use("/health", healthRouter);

  const bypassIps = config.RATE_LIMIT_BYPASS_IPS
    .split(",").map((value) => value.trim()).filter(Boolean);
  app.use(concurrencyBudget({
    maxConcurrent: config.HTTP_MAX_CONCURRENCY,
    maxConcurrentPerIp: config.HTTP_MAX_CONCURRENCY_PER_IP,
    bypassIps,
  }));
  app.use(makeRateLimiter({
    namespace: "global",
    capacity: config.RATE_LIMIT_GLOBAL_CAPACITY,
    perMinute: config.RATE_LIMIT_GLOBAL_PER_MIN,
    bypassIps,
  }));

  app.use(
    "/standard-rail",
    (req, res, next) => {
      if (req.method !== "POST") return next();
      const mediaType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const encoding = req.header("content-encoding")?.trim().toLowerCase();
      if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
        res.status(415).json({ error: "uncompressed_application_json_required" });
        return;
      }
      next();
    },
    express.json({
      limit: "2mb",
      inflate: false,
      verify: (req, _res, body) => {
        (req as Request & { rawBody?: Buffer }).rawBody = body;
      },
    }),
    (req, res, next) => {
      const body = (req as Request & { rawBody?: Buffer }).rawBody;
      try {
        if (body?.length) assertNoDuplicateJsonKeys(body.toString("utf8"));
        next();
      } catch {
        res.status(400).json({ error: "duplicate_json_key" });
      }
    },
  );

  app.use("/.well-known", wellKnownRouter);
  app.use("/agent-cards", agentCardRouter);
  app.use("/skills", skillsDocsRouter);
  app.get("/llms.txt", llmsTxtHandler);
  app.use(
    "/standard-rail",
    async (_req, res, next) => {
      if (!(await providerReady())) {
        res.setHeader("Retry-After", "30");
        res.status(503).json({ error: "provider_not_ready" });
        return;
      }
      next();
    },
    makeRateLimiter({
      namespace: "standard-rail",
      capacity: config.RATE_LIMIT_RAIL_CAPACITY,
      perMinute: config.RATE_LIMIT_RAIL_PER_MIN,
      bypassIps,
    }),
    createStandardRailRouter(config, standard),
  );

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError("HTTP request failed", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

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
