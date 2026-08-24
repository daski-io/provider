import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import type { ServiceRow } from "../db/queries/services.js";
import {
  generateRegistrationFile,
  buildAgentRegistryId,
} from "./registration.js";
import { config } from "../config.js";

/**
 * Serves ERC-8004 well-known files.
 *
 * Routes (per ERC-8004 draft commit 503591a6):
 *   GET /.well-known/agent.json                — agent registration file
 *   GET /.well-known/agent-registration.json   — same, spec-name variant
 *
 * The registration file describes the PROVIDER (one ERC-8004 agentId)
 * and lists one `services[name="A2A"]` entry per active service — the
 * gateway's discovery cache fetches every entry and catalogs each
 * service separately. Resolution strategy:
 *   1. If a `Host` header matches a service's `agent_domain`, that
 *      service's card leads the list (split-deploy setups where each
 *      service fronts its own hostname).
 *   2. Remaining active services follow in creation order, so the
 *      provider's flagship (first-registered) service stays the
 *      "primary" card for legacy single-card consumers.
 *
 * The spec's Endpoint Domain Verification note (§Endpoint Domain Verification)
 * requires the response to include at least a `registrations` entry whose
 * `agentRegistry`/`agentId` match the on-chain registration.
 */
export const wellKnownRouter = Router();

async function resolveServices(req: Request): Promise<ServiceRow[]> {
  const all = await pool.query(
    `SELECT * FROM services WHERE is_active = true ORDER BY created_at`,
  );
  const services = all.rows as ServiceRow[];

  const host = req.header("host")?.toLowerCase();
  if (host) {
    // Strip :port if present. A host-matched service leads the list.
    const domain = host.split(":")[0];
    const idx = services.findIndex((s) => s.agent_domain === domain);
    if (idx > 0) {
      const [matched] = services.splice(idx, 1);
      services.unshift(matched!);
    }
  }
  return services;
}

async function serveRegistrationFile(req: Request, res: Response) {
  const services = await resolveServices(req);
  if (services.length === 0) {
    res.status(404).json({ error: "No active service configured" });
    return;
  }

  const registrationFile = generateRegistrationFile(services, {
    agentRegistry: buildAgentRegistryId(
      config.CHAIN_ID,
      config.IDENTITY_REGISTRY_ADDRESS,
    ),
  });
  res.json(registrationFile);
}

wellKnownRouter.get("/agent.json", serveRegistrationFile);
wellKnownRouter.get("/agent-registration.json", serveRegistrationFile);
