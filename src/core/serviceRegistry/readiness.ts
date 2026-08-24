import { getScreeningExtension } from "../screening/registry.js";
import type { ServiceModule } from "./types.js";

/** Evaluate only the invariants owned by one service and its screening facet. */
export async function serviceInvariantFailures(
  module: ServiceModule,
): Promise<string[]> {
  const reasons: string[] = [];
  try {
    reasons.push(...await module.operations?.readiness?.checkInvariants?.() ?? []);
    const scopes = module.screening?.requiredScopes ?? [];
    if (scopes.length === 0) return reasons;

    const extension = getScreeningExtension();
    if (!extension) return [...reasons, "required screening extension is not installed"];
    const missing = scopes.filter((scope) => !extension.scopes.includes(scope));
    if (missing.length > 0) {
      reasons.push(`screening scopes unavailable: ${missing.join(", ")}`);
    }
    reasons.push(...await extension.readiness?.checkInvariants?.() ?? []);
    return reasons;
  } catch {
    return ["invariant check failed"];
  }
}
