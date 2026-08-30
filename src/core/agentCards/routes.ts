import { Router } from "express";
import type { Hex } from "viem";
import { config } from "../config.js";
import { loadRuntimeListingHeads } from "../gatewayRegistration/runtimeCatalog.js";
import { getService } from "../serviceRegistry/registry.js";
import { generateAgentCard } from "./generator.js";

export const agentCardRouter = Router();

agentCardRouter.get("/:serviceSlug.json", async (req, res) => {
  const service = getService(String(req.params.serviceSlug));
  if (!service) {
    res.status(404).json({ error: "service_not_found" });
    return;
  }
  const heads = await loadRuntimeListingHeads(new URL(config.GATEWAY_BASE_URL).origin);
  const serviceIds = new Set(heads
    .filter((head) => head.bundle.intent.payload.serviceSlug === service.manifest.slug)
    .map((head) => head.serviceId.toLowerCase() as Hex));
  if (serviceIds.size > 1) {
    throw new Error(`Runtime catalog has conflicting service ids for ${service.manifest.slug}`);
  }
  res.json(generateAgentCard(service, [...serviceIds][0] ?? null));
});
