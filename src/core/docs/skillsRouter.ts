import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getAllServices, getService } from "../serviceRegistry/registry.js";

export const skillsDocsRouter = Router();

skillsDocsRouter.get("/:serviceSlug/:skillId.md", (req, res) => {
  const service = getService(String(req.params.serviceSlug));
  const skillId = String(req.params.skillId);
  const markdown = service?.docs.skills[skillId];
  if (!markdown) {
    res.status(404).type("text/markdown").send("# Skill not found\n");
    return;
  }
  res.type("text/markdown").send(markdown);
});

skillsDocsRouter.get("/:serviceSlug.md", (req, res) => {
  const service = getService(String(req.params.serviceSlug));
  if (!service) {
    res.status(404).type("text/markdown").send("# Service not found\n");
    return;
  }
  res.type("text/markdown").send(service.docs.service);
});

export function llmsTxtHandler(_req: Request, res: Response): void {
  const lines = [
    "# Daski Provider",
    "",
    "Fixed-price synchronous services fulfilled through the Daski standard rail.",
    "Buyer agents use the Daski gateway; this provider does not expose a direct buyer A2A endpoint.",
    "",
    "## Services",
    "",
  ];
  for (const service of getAllServices()) {
    const slug = service.manifest.slug;
    lines.push(`- [${service.manifest.name}](${config.BASE_URL}/skills/${slug}.md)`);
    lines.push(`  - AgentCard: ${config.BASE_URL}/agent-cards/${slug}.json`);
    for (const skill of service.skills) {
      lines.push(
        `  - Skill: \`${skill.id}\` — ${config.BASE_URL}/skills/${slug}/${skill.id}.md`,
      );
    }
  }
  res.type("text/plain").send(`${lines.join("\n")}\n`);
}
