import { Router } from "express";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillsByServiceId } from "../db/queries/skills.js";
import { generateAgentCard } from "./generator.js";

export const agentCardRouter = Router();

agentCardRouter.get("/:serviceSlug.json", async (req, res) => {
  const slug = req.params.serviceSlug;

  const service = await getServiceBySlug(slug);
  if (!service || !service.is_active) {
    return res.status(404).json({ error: "Service not found" });
  }

  const skills = await getSkillsByServiceId(service.id);
  const card = generateAgentCard(service, skills);

  res.json(card);
});
