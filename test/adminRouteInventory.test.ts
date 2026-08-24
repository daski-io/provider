import { describe, expect, it } from "vitest";
import { adminUiRouter } from "../src/core/admin/ui/index.js";

interface RouteLayer {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
  };
}

function routeInventory(): string[] {
  return (adminUiRouter.stack as RouteLayer[]).flatMap((layer) => {
    if (typeof layer.route?.path !== "string") return [];
    return Object.entries(layer.route.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toUpperCase()} ${layer.route?.path as string}`);
  });
}

describe("admin route inventory", () => {
  it("keeps operational decisions in the complete review workflow", () => {
    expect(routeInventory()).toEqual(expect.arrayContaining([
      "GET /chat",
      "POST /chat",
      "POST /chat/clear",
      "POST /chat/confirm",
      "GET /transactions",
      "GET /transactions/:id",
      "GET /customers",
      "GET /customers/:id",
      "GET /reviews",
      "GET /reviews/count",
      "GET /reviews/:id",
      "POST /reviews/:id/decision",
      "POST /reviews/:id/action",
      "POST /reviews/:id/retry",
      "POST /reviews/:id/reply",
      "POST /reviews/confirm",
    ]));
    expect(routeInventory()).not.toContain("GET /operations");
  });
});
