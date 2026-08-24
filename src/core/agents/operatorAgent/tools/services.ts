import { listAllServices } from "../../../db/queries/services.js";
import type { OperatorTool } from "./shared.js";

export const listServicesTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "list_services",
      description:
        "List the provider's services with id, slug, version, supplier, and active status.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    const services = await listAllServices();
    return JSON.stringify(
      services.map((s) => ({
        id: s.id,
        slug: s.slug,
        version: s.version,
        name: s.name,
        supplier: s.supplier,
        is_active: s.is_active,
        on_chain_id: s.on_chain_id ? "0x" + s.on_chain_id.toString("hex") : null,
      })),
    );
  },
};
