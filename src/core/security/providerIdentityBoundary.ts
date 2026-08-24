import type { RequestHandler } from "express";
import { getProviderIdentityAuthorization } from "../chain/providerIdentity.js";

/** Fail closed on public service routes when this process no longer controls the provider agent. */
export const requireCurrentProviderIdentity: RequestHandler =
  (_req, res, next) => {
    if (getProviderIdentityAuthorization().ok) {
      next();
      return;
    }
    res.status(503).json({ error: "provider_identity_unavailable" });
  };
