// Shared Email Agent tools (scope: "all" — visible for every service).
// Split one-group-per-file so each is reviewable on its own; this barrel
// assembles the SHARED_TOOLS array and re-exports the context types.
//
// Service-specific tools live in src/services/<slug>/tools/ and are
// contributed via the ServiceModule.agents.emailAgentTools() hook; the registry
// (../toolRegistry.ts) merges them with these and scopes the result to
// the email's resolved service at triage time.

import { classify } from "./classify.js";
import { replyToSender } from "./respond.js";
import { escalateToOperator } from "./escalate.js";
import type { EmailAgentTool } from "./context.js";

export type { EmailAgentContext, EmailAgentTool, Tool, ToolDefinition } from "./context.js";

export const SHARED_TOOLS: EmailAgentTool[] = [
  classify,
  replyToSender,
  escalateToOperator,
];
