import {
  createServiceRule,
  listServiceRules,
} from "../../../db/queries/serviceRules.js";
import type { OperatorTool } from "./shared.js";
import { confirmationGate, executeConfirmedAction } from "../confirmation.js";
import { confirmationPendingResult } from "../confirmationPresentation.js";

export const listServiceRulesTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "list_service_rules",
      description: "List operator-curated rules for a service.",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "string" },
          active_only: { type: "boolean" },
        },
        required: ["service_id"],
      },
    },
  },
  async execute(args) {
    const rules = await listServiceRules({
      service_id: String(args.service_id),
      active_only: args.active_only !== false,
    });
    return JSON.stringify({
      count: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        scope: r.scope,
        skill_id: r.skill_id,
        rule: r.rule,
        active: r.active,
        created_by: r.created_by,
        created_at: r.created_at.toISOString(),
      })),
    });
  },
};

export const addServiceRuleTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "add_service_rule",
      description:
        "Add a new operator rule for a service. Two-step: the first call creates an exact preview and renders an Approve exact action button; after the explicit browser approval (a new operator message arrives automatically), repeat the same call to execute. The previewed rule text is stored and is what persists.",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "string", description: "The service id this rule applies to." },
          skill_id: {
            type: "string",
            description: "Optional skill id; omit for service-wide rule.",
          },
          scope: {
            type: "string",
            enum: ["all", "email_agent", "pre_execute"],
            description: "Which agent(s) see this rule.",
          },
          rule: { type: "string", description: "Plain-English rule text. Captured at preview time; the approved preview's text is what persists." },
        },
        required: ["service_id", "scope", "rule"],
      },
    },
  },
  async execute(args, ctx) {
    if (ctx.mode === "autonomous") {
      return JSON.stringify({ ok: false, reason: "not_authorized" });
    }
    const serviceId = String(args.service_id);
    const skillId =
      typeof args.skill_id === "string" && args.skill_id.length > 0 ? args.skill_id : null;
    const scope = args.scope as "all" | "email_agent" | "pre_execute";
    const rule = String(args.rule);
    const confirmation = await confirmationGate({
      ctx,
      actionName: "add_service_rule",
      arguments: { service_id: serviceId, skill_id: skillId, scope },
      payload: { rule },
      targetType: "service_rules",
      targetId: serviceId,
    });
    if (confirmation.status === "pending") {
      return confirmationPendingResult(confirmation, {
        message: `Add this ${scope} rule to service ${serviceId}: ${rule}`,
        pending: { service_id: serviceId, skill_id: skillId, scope, rule },
      });
    }
    if (confirmation.status === "denied") {
      return JSON.stringify({
        ok: false,
        reason: confirmation.reason,
        message: confirmation.message,
      });
    }
    const row = await executeConfirmedAction(confirmation, () => createServiceRule({
      service_id: serviceId,
      skill_id: skillId,
      scope,
      // The human-approved preview's rule text, not a retyped one.
      rule: String(confirmation.payload.rule ?? rule),
      created_by: ctx.actor,
    }));
    return JSON.stringify({ ok: true, rule_id: row.id });
  },
};
