import { Router } from "express";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "../config.js";
import { logWarn } from "../logger.js";
import { assertExactKeys } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { StandardDispatchService } from "./dispatch.js";
import type {
  DispatchStatusQueryV1,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

export function createStandardRailRouter(
  core: Config,
  config: ProviderStandardRailConfig,
): Router {
  const dispatch = new StandardDispatchService(
    config,
    core.CHAIN_ID === 8453 ? base : baseSepolia,
    core.CHAIN_ID,
  );
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

  router.post("/dispatch", async (req, res) => {
    try {
      assertExactKeys(
        req.body,
        ["dispatch", "quote", "request", "evidenceBundle"],
        "dispatch request",
      );
      const body = req.body as {
        dispatch?: SignedEnvelope<StandardRailDispatchV2, 2>;
        quote?: SignedEnvelope<QuoteV1>;
        request?: Record<string, unknown>;
        evidenceBundle?: StandardEvidenceBundleV2;
      };
      if (!body.dispatch || !body.quote || !body.request || !body.evidenceBundle) {
        res.status(400).json({ error: "invalid_dispatch" });
        return;
      }
      res.json(await dispatch.accept({
        dispatch: body.dispatch,
        quote: body.quote,
        request: body.request,
        evidenceBundle: body.evidenceBundle,
      }));
    } catch (error) {
      logWarn("Standard dispatch rejected", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(409).json({ error: "dispatch_rejected" });
    }
  });

  router.post("/dispatch/status", async (req, res) => {
    try {
      assertExactKeys(req.body, ["query"], "dispatch status request");
      const query = (req.body as {
        query?: SignedEnvelope<DispatchStatusQueryV1>;
      }).query;
      if (!query) {
        res.status(400).json({ error: "invalid_dispatch_status" });
        return;
      }
      res.json(await dispatch.status(query));
    } catch (error) {
      logWarn("Dispatch status rejected", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(404).json({ error: "dispatch_status_unavailable" });
    }
  });

  return router;
}
