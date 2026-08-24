import { Router } from "express";
import { authorizePostmark } from "./postmarkAuth.js";
import { processPostmarkDelivery } from "./postmarkDelivery.js";
import { processPostmarkInbound } from "./postmarkInboundProcessing.js";

export const postmarkWebhookRouter: Router = Router();

postmarkWebhookRouter.post("/postmark/inbound", async (req, res) => {
  if (!authorizePostmark(req)) {
    res.status(401).json({ ok: false, reason: "unauthorized" });
    return;
  }
  const result = await processPostmarkInbound(req.body);
  res.status(result.status).json(result.body);
});

postmarkWebhookRouter.post("/postmark/delivery", async (req, res) => {
  if (!authorizePostmark(req)) {
    res.status(401).json({ ok: false, reason: "unauthorized" });
    return;
  }
  await processPostmarkDelivery(req.body);
  res.status(200).json({ ok: true });
});
