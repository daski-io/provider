// Shared tool-call interfaces for the LLM agents (Operator Agent +
// Email Agent). Both agents wrap OpenAI's function-calling shape, and
// both keep a per-call context object (the wallet for operator, the
// inbound email for email triage). Generic on the context shape so each
// agent can carry exactly what its tools need.

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Tool<TContext = Record<string, unknown>> {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: TContext): Promise<string>;
  /**
   * Which service(s) this tool applies to, by slug. `"all"` (the default
   * when omitted) means every service sees it. The Email Agent filters
   * its tool list to those in scope for the email's resolved service —
   * shared triage tools are `"all"`, service-contributed tools default to
   * `[<own slug>]`, and a multi-service tool sets `["a","b"]`. The
   * Operator Agent ignores this field (its tools are global).
   */
  scope?: "all" | string[];
}
