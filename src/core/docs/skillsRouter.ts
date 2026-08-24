import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getService, getAllServices } from "../serviceRegistry/registry.js";

export const skillsDocsRouter = Router();

// GET /skills/<service-slug>/<skill-id>.md
// Backs the AgentCard documentationUrl on every skill.
skillsDocsRouter.get(
  "/:serviceSlug/:skillId.md",
  async (req: Request, res: Response) => {
    const slug = String(req.params.serviceSlug);
    const skillId = String(req.params.skillId);
    const module = getService(slug);
    if (!module) {
      res.status(404).type("text/markdown").send(`# Service not found\n\n${slug} is not registered on this provider.\n`);
      return;
    }
    const md = module.protocol.docs.skills[skillId];
    if (!md) {
      res.status(404).type("text/markdown").send(`# Skill not documented\n\n${skillId} has no documentation registered.\n`);
      return;
    }
    res.type("text/markdown").send(md);
  },
);

// GET /skills/<service-slug>.md — service overview.
skillsDocsRouter.get("/:serviceSlug.md", async (req: Request, res: Response) => {
  const slug = String(req.params.serviceSlug);
  const module = getService(slug);
  if (!module) {
    res.status(404).type("text/markdown").send(`# Service not found\n`);
    return;
  }
  const md = module.protocol.docs.service;
  res.type("text/markdown").send(md);
});

/// /llms.txt — Cloudflare-style catalog. Lists every service slug and
/// links to its overview + AgentCard. Mounted at top-level by core/server.ts.
export async function llmsTxtHandler(_req: Request, res: Response): Promise<void> {
  const services = getAllServices();
  const lines: string[] = [
    "# Daski Provider",
    "",
    "Programmatic services exposed via A2A v1. Each service has its own AgentCard, skills, and documentation.",
    "",
    "## Services",
    "",
  ];
  for (const m of services) {
    const slug = m.manifest.slug;
    lines.push(`- [${m.manifest.name}](${config.BASE_URL}/skills/${slug}.md)`);
    lines.push(`  - AgentCard: ${config.BASE_URL}/agent-cards/${slug}.json`);
    lines.push(`  - A2A endpoint: ${config.BASE_URL}/a2a/${slug}`);
    for (const skill of m.skills) {
      lines.push(
        `  - Skill: \`${skill.id}\` — ${config.BASE_URL}/skills/${slug}/${skill.id}.md`,
      );
    }
  }
  res.type("text/plain").send(lines.join("\n") + "\n");
}
