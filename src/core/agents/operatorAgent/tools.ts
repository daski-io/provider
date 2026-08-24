import { getAllServices } from "../../serviceRegistry/registry.js";
import { getScreeningExtension } from "../../screening/registry.js";
import { listServicesTool } from "./tools/services.js";
import { getTransactionTool, listTransactionsTool } from "./tools/transactions.js";
import {
  getEscalationTool,
  listOpenEscalationsTool,
  replyToBuyerTool,
  requestHumanReviewTool,
  resolveEscalationTool,
} from "./tools/escalations.js";
import { addServiceRuleTool, listServiceRulesTool } from "./tools/rules.js";
import {
  listLegalHoldsTool,
  placeLegalHoldTool,
  releaseLegalHoldTool,
} from "./tools/legalHolds.js";
import { replaceProviderWriteFeeTool } from "./tools/providerWrites.js";
import {
  abortReputationOutcomeTool,
  reconcileReputationOutcomeTool,
  retryReputationOutcomeOnceTool,
} from "./tools/reputation.js";
import { retryStalledAutomationTool } from "./tools/stalledAutomation.js";
import type { OperatorTool, ToolContext } from "./tools/shared.js";
import { getOperationsSummaryTool } from "./tools/operations.js";

export type { Tool, ToolDefinition, ToolContext } from "./tools/shared.js";

const READ_TOOLS: OperatorTool[] = [
  listServicesTool,
  listTransactionsTool,
  getTransactionTool,
  listOpenEscalationsTool,
  getEscalationTool,
  listServiceRulesTool,
  listLegalHoldsTool,
  getOperationsSummaryTool,
];

const HUMAN_ACTION_TOOLS: OperatorTool[] = [
  addServiceRuleTool,
  placeLegalHoldTool,
  releaseLegalHoldTool,
];

const REVIEW_ACTION_TOOLS: OperatorTool[] = [
  replaceProviderWriteFeeTool,
  reconcileReputationOutcomeTool,
  retryReputationOutcomeOnceTool,
  abortReputationOutcomeTool,
  retryStalledAutomationTool,
];

export const ESCALATION_AUTONOMOUS_TOOLS: OperatorTool[] = [
  getEscalationTool,
  replyToBuyerTool,
  resolveEscalationTool,
  requestHumanReviewTool,
];

export const FREE_FORM_TOOLS: OperatorTool[] = [...READ_TOOLS, ...HUMAN_ACTION_TOOLS];
export const ESCALATION_HUMAN_TOOLS: OperatorTool[] = [
  ...FREE_FORM_TOOLS,
  replyToBuyerTool,
  ...REVIEW_ACTION_TOOLS,
  resolveEscalationTool,
];

function serviceReadTools(): OperatorTool[] {
  return getAllServices().flatMap((service) =>
    service.agents?.operatorAgentTools?.() ?? []);
}

function serviceActionTools(): OperatorTool[] {
  return [
    ...getAllServices().flatMap((service) =>
      service.agents?.operatorAgentActionTools?.() ?? []),
    ...(getScreeningExtension()?.operatorTools?.() ?? []),
  ];
}

export function validateOperatorAgentTools(): void {
  const origins = new Map<string, string>();
  const register = (tool: OperatorTool, origin: string) => {
    const name = tool.definition.function.name;
    const prior = origins.get(name);
    if (prior) {
      throw new Error(`Operator Agent tool name collision: "${name}" from ${origin}; already defined by ${prior}.`);
    }
    origins.set(name, origin);
  };
  for (const tool of READ_TOOLS) register(tool, "core:chat_read");
  for (const tool of HUMAN_ACTION_TOOLS) register(tool, "core:human_confirmed");
  for (const tool of REVIEW_ACTION_TOOLS) register(tool, "core:review_confirmed");
  for (const tool of [replyToBuyerTool, resolveEscalationTool, requestHumanReviewTool]) {
    register(tool, "core:autonomous_email_triage");
  }
  for (const service of getAllServices()) {
    for (const tool of service.agents?.operatorAgentTools?.() ?? []) {
      register(tool, `service:${service.manifest.slug}:chat_read`);
    }
    for (const tool of service.agents?.operatorAgentActionTools?.() ?? []) {
      register(tool, `service:${service.manifest.slug}:human_confirmed`);
    }
  }
  for (const tool of getScreeningExtension()?.operatorTools?.() ?? []) {
    register(tool, "extension:screening");
  }
}

export function toolsForMode(ctx: ToolContext): OperatorTool[] {
  if (ctx.mode === "autonomous") return [...ESCALATION_AUTONOMOUS_TOOLS];
  const humanTools = [
    ...READ_TOOLS,
    ...HUMAN_ACTION_TOOLS,
    ...serviceReadTools(),
    ...serviceActionTools(),
  ];
  return ctx.escalationId
    ? [...humanTools, ...REVIEW_ACTION_TOOLS, replyToBuyerTool, resolveEscalationTool]
    : humanTools;
}
