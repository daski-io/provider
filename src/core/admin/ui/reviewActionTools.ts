import type { ToolContext, OperatorTool } from "../../agents/operatorAgent/tools/shared.js";
import { getScreeningExtension } from "../../screening/registry.js";
import { getAllServices } from "../../serviceRegistry/registry.js";
import { coreReviewActionTools } from "./coreReviewActions.js";

export interface ReviewActionTool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function listReviewActionTools(): ReviewActionTool[] {
  const providerTools: OperatorTool[] = [];
  for (const service of getAllServices()) {
    providerTools.push(...(service.agents?.operatorAgentActionTools?.() ?? []));
  }
  providerTools.push(...(getScreeningExtension()?.operatorTools?.() ?? []));

  const unique = new Map<string, ReviewActionTool>();
  for (const tool of coreReviewActionTools()) unique.set(tool.name, tool);
  for (const tool of providerTools) {
    const name = tool.definition.function.name;
    if (unique.has(name)) throw new Error(`Duplicate review action tool: ${name}`);
    unique.set(name, {
      name,
      description: tool.definition.function.description,
      execute: tool.execute,
    });
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}
