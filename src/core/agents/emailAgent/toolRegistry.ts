import { getAllServices } from "../../serviceRegistry/registry.js";
import { SHARED_TOOLS } from "./tools/index.js";
import type { EmailAgentTool } from "./tools/context.js";

// Email Agent tool registry. Collects the shared triage tools plus every
// registered service module's emailAgentTools() and scopes the result to
// a given service at triage time.
//
//   - Shared tools (SHARED_TOOLS) carry no `scope` → treated as "all".
//   - Service-contributed tools default to `[<own slug>]` if they don't
//     set a scope; a multi-service tool sets `["a","b"]` explicitly and
//     lives in one owning service's tools/ folder.
//
// Built fresh on each call. Service registration happens once at boot
// before any email arrives, and the per-call cost is a few array concats,
// so there's no caching to invalidate when tests register services.

/// All Email Agent tools across shared + every registered service, with
/// service-contributed tools' default scope stamped on.
export function collectEmailAgentTools(): EmailAgentTool[] {
  const out: EmailAgentTool[] = [...SHARED_TOOLS];
  for (const module of getAllServices()) {
    const tools = module.agents?.emailAgentTools?.() ?? [];
    for (const t of tools) {
      // Stamp the per-service default scope when the tool didn't declare
      // one, so the registry — not each service author — owns the rule.
      out.push(t.scope ? t : { ...t, scope: [module.manifest.slug] });
    }
  }
  return out;
}

function inScope(tool: EmailAgentTool, slug: string): boolean {
  const scope = tool.scope ?? "all";
  return scope === "all" || scope.includes(slug);
}

/// The tools visible to the Email Agent for a given service slug: shared
/// tools plus the service's own (and any multi-service tool naming it).
export function toolsForService(slug: string): EmailAgentTool[] {
  return collectEmailAgentTools().filter((t) => inScope(t, slug));
}

/// Boot-time guard: for every registered service, the set the Email Agent
/// would actually see (shared + that service's in-scope tools) must have
/// unique tool names. A collision would make TOOLS_BY_NAME ambiguous and
/// silently drop one tool. Throws with the offending slug + name so the
/// deploy fails fast rather than mis-dispatching at runtime.
export function validateEmailAgentTools(): void {
  const all = collectEmailAgentTools();
  // Resolvable sets = one per registered service slug, plus the bare
  // shared set (covers the "no services" / pre-registration case).
  const slugs = new Set<string>(["__shared_only__"]);
  for (const m of getAllServices()) slugs.add(m.manifest.slug);

  for (const slug of slugs) {
    const seen = new Map<string, EmailAgentTool>();
    const visible =
      slug === "__shared_only__"
        ? all.filter((t) => (t.scope ?? "all") === "all")
        : all.filter((t) => inScope(t, slug));
    for (const t of visible) {
      const name = t.definition.function.name;
      if (seen.has(name)) {
        const where = slug === "__shared_only__" ? "shared tools" : `service "${slug}"`;
        throw new Error(
          `Email Agent tool name collision in ${where}: "${name}" is defined more than once.`,
        );
      }
      seen.set(name, t);
    }
  }
}
