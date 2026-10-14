import { Router, type Request } from "express";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "../config.js";
import { externalJobKeyRing } from "../externalJobs/keyRing.js";
import { idleExternalJobRuntime, type ExternalJobRuntime } from "../externalJobs/runtime.js";
import { logError, logWarn } from "../logger.js";
import { respondAmbiguously, respondLifecycleUnavailable } from "../security/servicingIngress.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { StandardDispatchService, type DispatchDependencies } from "./dispatch.js";
import {
  DispatchRejectedError,
  DispatchStatusNoClaimError,
  DispatchStatusRejectedError,
  type DispatchRejectionReason,
} from "./dispatchErrors.js";
import { StandardLifecycleService, type LifecycleDependencies } from "./lifecycle.js";
import { LifecycleRefusal, LifecycleRejectedError } from "./lifecycleErrors.js";
import { StandardQuoteService } from "./quote.js";
import { boundedRefusalBody, QuoteRefusal, QuoteUnavailable } from "./quoteErrors.js";

const REJECTION_STATUS: Readonly<Record<DispatchRejectionReason, number>> = {
  validator: 400,
  signature: 401,
  envelope_lifetime: 409,
  outcome_policy: 409,
  quote_window: 409,
  price: 409,
  self_purchase: 409,
  evidence: 409,
  service_unavailable: 503,
};
const STATUS_REJECTION_STATUS = { query_invalid: 400, signature: 401, binding_conflict: 409 } as const;

const errorClass = (error: unknown) => error instanceof Error ? error.name : "UnknownError";
const causeClass = (error: unknown) =>
  errorClass((error as { cause?: unknown } | null)?.cause ?? null);

export function createStandardRailRouter(
  core: Config,
  config: ProviderStandardRailConfig,
  options: {
    recordServicingFailure?: (req: Request) => void;
    dispatch?: DispatchDependencies;
    lifecycle?: LifecycleDependencies;
    externalJobs?: ExternalJobRuntime;
  } = {},
): Router {
  // Without a worker in this process, external jobs are still admitted for
  // funded orders, but none is sold (externalJobs/sales.ts).
  const externalJobs = options.externalJobs ?? idleExternalJobRuntime(
    externalJobKeyRing(core, config.retainedSigningKeys.values()),
    core.PROVIDER_AGENT_ID.toString(),
  );
  const dispatch = new StandardDispatchService(
    config,
    core.CHAIN_ID === 8453 ? base : baseSepolia,
    core.CHAIN_ID,
    { externalJobs, ...options.dispatch },
  );
  const lifecycle = new StandardLifecycleService(config, core.CHAIN_ID, {
    signer: options.dispatch?.signer,
    ...options.lifecycle,
  });
  const quotes = new StandardQuoteService(config, core.CHAIN_ID, { externalJobs });
  const recordFailure = options.recordServicingFailure ?? (() => undefined);
  const router = Router();

  router.get("/outcomes", (_req, res) => {
    res.json({
      version: 1,
      providerAudience: config.providerAudience,
      outcomes: [...config.outcomes.values()].map((outcome) => ({
        outcomeId: outcome.outcomeId,
        serviceSlug: outcome.serviceSlug,
        skillId: outcome.skillId,
        listingManifestHash: outcome.listingManifestHash,
        providerOfferHash: outcome.providerOfferHash,
        bindingProfile: outcome.bindingProfile,
        pricingMode: "fixed",
      })),
    });
  });

  router.post("/quote", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = req.body as Record<string, unknown> | undefined;
    const request = body?.request;
    if (
      !body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).join() !== "request"
      || !request || typeof request !== "object" || Array.isArray(request)
    ) {
      res.status(400).json({ error: "invalid_quote_request" });
      return;
    }
    try {
      res.json(await quotes.handle(request as Record<string, unknown>));
    } catch (error) {
      if (error instanceof QuoteRefusal) {
        logWarn("Standard quote refused", { kind: error.kind, reason: error.reason });
        res.status(error.status).json(boundedRefusalBody(error));
        return;
      }
      if (error instanceof QuoteUnavailable) {
        logWarn("Standard quote unavailable", { reason: error.reason });
        res.setHeader("Retry-After", "30");
        res.status(503).json({ error: "quote_unavailable", reason: error.reason });
        return;
      }
      logError("Standard quote failed", { errorClass: errorClass(error) });
      res.setHeader("Retry-After", "30");
      res.status(503).json({ error: "quote_unavailable", reason: "service_unavailable" });
    }
  });

  // C03: a JSON `error` here only ever means "definitely not admitted".
  router.post("/dispatch", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await dispatch.accept(req.body));
    } catch (error) {
      if (error instanceof DispatchRejectedError) {
        if (!error.authenticated) recordFailure(req);
        logWarn("Standard dispatch refused before admission", { reason: error.reason });
        if (error.reason === "service_unavailable") res.setHeader("Retry-After", "30");
        res.status(REJECTION_STATUS[error.reason])
          .json({ error: "dispatch_rejected", reason: error.reason });
        return;
      }
      logError("Standard dispatch answered ambiguously", {
        errorClass: errorClass(error),
        causeClass: causeClass(error),
      });
      respondAmbiguously(res);
    }
  });

  router.post("/dispatch/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await dispatch.status(req.body));
    } catch (error) {
      if (error instanceof DispatchStatusNoClaimError) {
        res.status(404).json({ error: "dispatch_status_unavailable", reason: "outcome_policy" });
        return;
      }
      if (error instanceof DispatchStatusRejectedError) {
        if (!error.authenticated) recordFailure(req);
        logWarn("Dispatch status query rejected", { reason: error.reason });
        res.status(STATUS_REJECTION_STATUS[error.reason])
          .json({ error: "dispatch_status_rejected", reason: error.reason });
        return;
      }
      logError("Dispatch status answered ambiguously", {
        errorClass: errorClass(error),
        causeClass: causeClass(error),
      });
      respondAmbiguously(res);
    }
  });

  // G02: only the named refusals reach the buyer, each with exactly one key;
  // anything that could not be decided is lifecycle_unavailable, never a 500.
  router.post("/lifecycle", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await lifecycle.handle(req.body));
    } catch (error) {
      if (error instanceof LifecycleRefusal) {
        res.status(409).json({ error: error.code });
        return;
      }
      if (error instanceof LifecycleRejectedError) {
        if (!error.authenticated) recordFailure(req);
        logWarn("Lifecycle call rejected", { reason: error.reason });
        res.status(error.status).json({ error: "lifecycle_rejected", reason: error.reason });
        return;
      }
      logError("Lifecycle call answered unavailable", {
        errorClass: errorClass(error),
        causeClass: causeClass(error),
      });
      respondLifecycleUnavailable(res);
    }
  });

  return router;
}

