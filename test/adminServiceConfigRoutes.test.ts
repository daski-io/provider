import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRule: vi.fn(),
  deactivateServiceRule: vi.fn(),
  emitEvent: vi.fn(),
  getService: vi.fn(),
  getServiceById: vi.fn(),
  getSkillsByServiceId: vi.fn(),
  getSupplierConfig: vi.fn(),
  setSupplierConfig: vi.fn(),
  updateServiceConfig: vi.fn(),
  updateServiceSkillPricing: vi.fn(),
}));

vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceById: mocks.getServiceById,
  updateServiceConfig: mocks.updateServiceConfig,
}));
vi.mock("../src/core/db/queries/skills.js", () => ({
  getSkillsByServiceId: mocks.getSkillsByServiceId,
  updateServiceSkillPricing: mocks.updateServiceSkillPricing,
}));
vi.mock("../src/core/db/queries/serviceRules.js", () => ({
  createServiceRule: mocks.createServiceRule,
  deactivateServiceRule: mocks.deactivateServiceRule,
}));
vi.mock("../src/core/suppliers/credentials.js", () => ({
  getSupplierConfig: mocks.getSupplierConfig,
  setSupplierConfig: mocks.setSupplierConfig,
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: mocks.emitEvent }));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getService: mocks.getService,
}));

import { mountConfigPage } from "../src/core/admin/ui/pages/config.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  const router = express.Router();
  mountConfigPage(router);
  app.use(router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateServiceConfig.mockResolvedValue({ id: "svc-1" });
});

async function post(path: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

describe("service workspace config routes", () => {
  it("updates an email field without changing service activity", async () => {
    const response = await post("/config/services/svc-1", new URLSearchParams({
      redirect_tab: "endpoints",
      outbound_email_from: "ops@example.com",
    }));

    expect(mocks.updateServiceConfig).toHaveBeenCalledWith(
      "svc-1",
      { outbound_email_from: "ops@example.com" },
      "admin",
    );
    expect(response.headers.get("location")).toBe(
      "/admin/ui/services/svc-1?tab=endpoints&ok=Service+config+saved.",
    );
  });

  it("uses the activity sentinel to persist an unchecked status", async () => {
    await post("/config/services/svc-1", new URLSearchParams({
      redirect_tab: "overview",
      is_active_present: "true",
    }));

    expect(mocks.updateServiceConfig).toHaveBeenCalledWith(
      "svc-1",
      { is_active: false },
      "admin",
    );
  });

  it("keeps credentials unchanged when saving supplier settings blank", async () => {
    mocks.getSupplierConfig.mockResolvedValue({
      config: { markup_pct: 0.2 },
      sandbox: true,
    });
    const response = await post("/config/suppliers/sample-supplier", new URLSearchParams({
      service_id: "svc-1",
      sandbox: "false",
      credentials_json: "",
    }));

    expect(mocks.setSupplierConfig).toHaveBeenCalledWith(
      "sample-supplier",
      { sandbox: false, configPatch: {} },
      "admin",
    );
    expect(response.headers.get("location")).toBe(
      "/admin/ui/services/svc-1?tab=supplier&ok=Supplier+config+saved.",
    );
  });

  it("updates every paid skill through one audited pricing command", async () => {
    mocks.getSkillsByServiceId.mockResolvedValue([
      {
        id: "skill-row-1",
        skill_id: "paid-one",
        is_active: true,
        pricing: {
          USDC: { type: "one-time", fixed_amount: "1000000" },
        },
      },
      {
        id: "skill-row-2",
        skill_id: "paid-two",
        is_active: true,
        pricing: {
          USDC: { type: "monthly", fixed_amount: "2000000" },
        },
      },
    ]);

    await post("/config/services/svc-1/pricing", new URLSearchParams({
      fixed_price_usd: "9.99",
    }));

    expect(mocks.updateServiceSkillPricing).toHaveBeenCalledOnce();
    expect(mocks.updateServiceSkillPricing).toHaveBeenCalledWith({
      serviceId: "svc-1",
      actor: "admin",
      fixedAmountAtomic: 9_990_000n,
      updates: [
        expect.objectContaining({
          id: "skill-row-1",
          skillId: "paid-one",
          pricing: {
            USDC: { type: "one-time", fixed_amount: "9990000" },
          },
        }),
        expect.objectContaining({
          id: "skill-row-2",
          skillId: "paid-two",
          pricing: {
            USDC: { type: "monthly", fixed_amount: "9990000" },
          },
        }),
      ],
    });
  });
});
