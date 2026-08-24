import type { Request, Response, Router } from "express";
import {
  getServiceById,
  updateServiceConfig,
} from "../../../db/queries/services.js";
import {
  getSkillsByServiceId,
  updateServiceSkillPricing,
} from "../../../db/queries/skills.js";
import {
  createServiceRule,
  deactivateServiceRule,
} from "../../../db/queries/serviceRules.js";
import { setSupplierConfig } from "../../../suppliers/credentials.js";
import { getService } from "../../../serviceRegistry/registry.js";
import { adminActionFailure } from "../actionFailure.js";
import { readFormBody } from "../util.js";
import {
  parseServiceWorkspaceTab,
  serviceWorkspaceUrl,
  type ServiceWorkspaceTab,
} from "./services/navigation.js";
import { pricingModeOf, usdStringToAtomic } from "./services/pricing.js";

function adminWallet(req: Request): string {
  return (req as Request & { _adminWallet?: string })._adminWallet ?? "admin";
}

function redirectToService(
  res: Response,
  serviceId: string,
  tab: ServiceWorkspaceTab,
  kind: "ok" | "err",
  message: string,
): void {
  res.redirect(serviceWorkspaceUrl(serviceId, tab, { kind, message }));
}

export function mountConfigPage(router: Router): void {
  // Configuration now lives inside the selected service workspace.
  router.get("/config", (_req: Request, res: Response) => {
    res.redirect("/admin/ui/services");
  });

  router.post("/config/services/:id", async (req: Request, res: Response) => {
    const serviceId = req.params.id as string;
    let tab: ServiceWorkspaceTab = "endpoints";
    try {
      const form = await readFormBody(req);
      tab = parseServiceWorkspaceTab(form.get("redirect_tab") ?? tab);
      const patch: Parameters<typeof updateServiceConfig>[1] = {};
      const supplier = form.get("supplier");
      if (supplier !== null) patch.supplier = supplier || null;
      const outbound = form.get("outbound_email_from");
      if (outbound !== null) patch.outbound_email_from = outbound || null;
      const inbound = form.get("inbound_email_address");
      if (inbound !== null) patch.inbound_email_address = inbound || null;
      const wallet = form.get("service_wallet");
      if (wallet !== null) patch.service_wallet = wallet || null;
      if (form.has("is_active_present")) {
        patch.is_active = form.get("is_active") === "on";
      }
      const updated = await updateServiceConfig(serviceId, patch, adminWallet(req));
      if (!updated) throw new Error("Service not found");
      redirectToService(res, serviceId, tab, "ok", "Service config saved.");
    } catch (error) {
      redirectToService(
        res,
        serviceId,
        tab,
        "err",
        adminActionFailure("service.config.update", error),
      );
    }
  });

  router.post("/config/services/:id/rules", async (req: Request, res: Response) => {
    const serviceId = req.params.id as string;
    try {
      const form = await readFormBody(req);
      const rule = form.get("rule");
      const scope = (form.get("scope") ?? "all") as
        | "all"
        | "email_agent"
        | "pre_execute";
      const skillId = form.get("skill_id");
      if (!rule?.trim()) throw new Error("Rule text required.");
      await createServiceRule({
        service_id: serviceId,
        skill_id: skillId?.trim() ? skillId : null,
        scope,
        rule: rule.trim(),
        created_by: adminWallet(req),
      });
      redirectToService(res, serviceId, "rules", "ok", "Rule added.");
    } catch (error) {
      redirectToService(
        res,
        serviceId,
        "rules",
        "err",
        adminActionFailure("service.rule.create", error),
      );
    }
  });

  router.post("/config/services/:id/pricing", async (req: Request, res: Response) => {
    const serviceId = req.params.id as string;
    const wallet = adminWallet(req);
    try {
      const form = await readFormBody(req);
      const raw = form.get("fixed_price_usd") ?? "";
      const atomic = usdStringToAtomic(raw);
      if (atomic === null) {
        throw new Error(`'${raw}' is not a valid USD price (e.g. 9.99).`);
      }
      const skills = await getSkillsByServiceId(serviceId);
      const { mode, paidSkills } = pricingModeOf(skills);
      if (mode !== "fixed") throw new Error("This service is not fixed-priced.");
      const updates: Parameters<
        typeof updateServiceSkillPricing
      >[0]["updates"] = paidSkills.map((skill) => {
        const currency = skill.pricing.USDC;
        return {
          id: skill.id,
          skillId: skill.skill_id,
          pricing: {
            ...skill.pricing,
            USDC: {
              type: currency?.type ?? "one-time",
              ...(currency?.interval ? { interval: currency.interval } : {}),
              fixed_amount: atomic.toString(),
            },
          },
        };
      });
      await updateServiceSkillPricing({
        serviceId,
        actor: wallet,
        fixedAmountAtomic: atomic,
        updates,
      });
      const display = (Number(atomic) / 1_000_000).toFixed(2);
      redirectToService(
        res,
        serviceId,
        "pricing",
        "ok",
        `Price updated to $${display} for ${paidSkills.length} paid skill(s).`,
      );
    } catch (error) {
      redirectToService(
        res,
        serviceId,
        "pricing",
        "err",
        adminActionFailure("service.pricing.update", error),
      );
    }
  });

  router.post("/config/services/:id/ext/:action", async (req: Request, res: Response) => {
    const serviceId = req.params.id as string;
    const wallet = adminWallet(req);
    try {
      const service = await getServiceById(serviceId);
      if (!service) throw new Error("Service not found");
      const handler = getService(service.slug)?.admin?.handleConfigAction;
      if (!handler) throw new Error("This service has no config actions");
      const form = await readFormBody(req);
      await handler(req.params.action as string, form, wallet);
      redirectToService(res, serviceId, "controls", "ok", "Service action completed.");
    } catch (error) {
      redirectToService(
        res,
        serviceId,
        "controls",
        "err",
        adminActionFailure("service.extension-action", error),
      );
    }
  });

  router.post("/config/rules/:id/deactivate", async (req: Request, res: Response) => {
    let serviceId = "";
    try {
      const form = await readFormBody(req);
      serviceId = form.get("service_id") ?? "";
      const rule = await deactivateServiceRule(
        req.params.id as string,
        adminWallet(req),
      );
      if (!rule) throw new Error("Rule not found");
      serviceId = rule.service_id;
      redirectToService(res, serviceId, "rules", "ok", "Rule deactivated.");
    } catch (error) {
      if (!serviceId) {
        res.redirect("/admin/ui/services");
        return;
      }
      redirectToService(
        res,
        serviceId,
        "rules",
        "err",
        adminActionFailure("service.rule.deactivate", error),
      );
    }
  });

  router.post("/config/suppliers/:supplier", async (req: Request, res: Response) => {
    let serviceId = "";
    const supplierId = req.params.supplier as string;
    const wallet = adminWallet(req);
    try {
      const form = await readFormBody(req);
      serviceId = form.get("service_id") ?? "";
      if (!serviceId) throw new Error("Service id required");
      const markup = form.get("markup_pct");
      const sandbox = form.get("sandbox");
      const credentialsJson = form.get("credentials_json");
      const configPatch: Record<string, unknown> = {};
      if (markup?.length) {
        const value = Number(markup);
        if (Number.isFinite(value) && value >= 0) configPatch.markup_pct = value;
      }
      const credentials = credentialsJson?.trim()
        ? JSON.parse(credentialsJson) as Record<string, string>
        : undefined;
      await setSupplierConfig(supplierId, {
        ...(credentials ? { credentials } : {}),
        ...(sandbox !== null ? { sandbox: sandbox === "true" } : {}),
        configPatch,
      }, wallet);
      redirectToService(res, serviceId, "supplier", "ok", "Supplier config saved.");
    } catch (error) {
      if (!serviceId) {
        res.redirect("/admin/ui/services");
        return;
      }
      redirectToService(
        res,
        serviceId,
        "supplier",
        "err",
        adminActionFailure("service.supplier.update", error),
      );
    }
  });
}
