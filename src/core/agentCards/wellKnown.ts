import { Router } from "express";
import { getAllServices } from "../serviceRegistry/registry.js";
import { generateRegistrationFile } from "./registration.js";

export const wellKnownRouter = Router();

function registration(_req: unknown, res: import("express").Response): void {
  const services = getAllServices();
  if (services.length === 0) {
    res.status(404).json({ error: "no_active_service" });
    return;
  }
  res.json(generateRegistrationFile(services));
}

wellKnownRouter.get("/agent.json", registration);
wellKnownRouter.get("/agent-registration.json", registration);
