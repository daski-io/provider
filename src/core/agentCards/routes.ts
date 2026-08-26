import { Router } from "express";
import { getService } from "../serviceRegistry/registry.js";
import { generateAgentCard } from "./generator.js";

export const agentCardRouter = Router();

agentCardRouter.get("/:serviceSlug.json", (req, res) => {
  const service = getService(String(req.params.serviceSlug));
  if (!service) {
    res.status(404).json({ error: "service_not_found" });
    return;
  }
  res.json(generateAgentCard(service));
});
