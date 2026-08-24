import type { Request, Response, Router } from "express";
import { getAssetById } from "../../../db/queries/assets.js";
import { getServiceById } from "../../../db/queries/services.js";
import { getService } from "../../../serviceRegistry/registry.js";
import { adminActionFailure } from "../actionFailure.js";
import { renderServiceDetail } from "./services/detail.js";
import { renderServicesList } from "./services/list.js";
import { serviceWorkspaceUrl } from "./services/navigation.js";

export { renderServiceDetail, renderServicesList };

function walletShort(req: Request): string | undefined {
  const wallet = (req as Request & { _adminWallet?: string })._adminWallet;
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : undefined;
}

export function mountServicesPages(router: Router): void {
  router.get("/services", async (req: Request, res: Response) => {
    res.type("html").send(await renderServicesList(walletShort(req)));
  });

  router.get("/services/:id", async (req: Request, res: Response) => {
    const html = await renderServiceDetail(
      req.params.id as string,
      walletShort(req),
      req,
    );
    if (!html) {
      res.status(404).type("html").send("Service not found");
      return;
    }
    res.type("html").send(html);
  });

  // Service-contributed asset actions are resolved through the registry so
  // core remains independent of individual service implementations.
  router.post(
    "/services/:id/assets/:assetId/actions/:actionId",
    async (req: Request, res: Response) => {
      const wallet =
        (req as Request & { _adminWallet?: string })._adminWallet ?? "admin";
      const serviceId = req.params.id as string;
      try {
        const service = await getServiceById(serviceId);
        if (!service) throw new Error("Service not found");
        const action = getService(service.slug)?.admin?.assetActions?.find(
          (candidate) => candidate.id === req.params.actionId,
        );
        if (!action) throw new Error("Unknown asset action");
        const asset = await getAssetById(req.params.assetId as string);
        if (!asset || asset.service_id !== service.id) {
          throw new Error("Asset not found for this service");
        }
        if (!action.appliesTo.includes(asset.status)) {
          throw new Error(
            `Action '${action.id}' does not apply to a ${asset.status} asset`,
          );
        }
        await action.run(asset, wallet);
        res.redirect(serviceWorkspaceUrl(serviceId, "overview", {
          kind: "ok",
          message: "Asset action completed.",
        }));
      } catch (error) {
        res.redirect(serviceWorkspaceUrl(serviceId, "overview", {
          kind: "err",
          message: adminActionFailure("service.asset-action", error),
        }));
      }
    },
  );
}
