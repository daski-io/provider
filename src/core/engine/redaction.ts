import { getService } from "../serviceRegistry/registry.js";
import { logError } from "../logger.js";
import { redactSensitiveValue } from "../security/redaction.js";
export { redactSensitiveText, redactSensitiveValue } from "../security/redaction.js";

// Sensitive-field redaction (spec core change 1). Services that accept
// PII beyond what the platform already treats carefully (SSNs, dates of
// birth) implement `ServiceModule.security.redactSensitiveFields(skillId, data)`;
// core applies it to persisted and emitted raw-data sinks:
//   (a) transactions.metadata.request_data persistence (settlement.ts)
//   (b) handleTaskInput's `transaction.message.user` event payload
//   (c) escalation edited_data logging + the request_data re-merge
//   (d) the executeAdapter result-event payload (defense-in-depth)
// Pre-execute LLM review uses a separate, minimal service projection so
// rules can receive safe derived fields without widening these sinks.
//
// Services without the hook are untouched. If a hook THROWS, we fail
// closed: the sink receives a stub instead of the raw data — a redaction
// bug must never widen into a PII leak.

export function applyServiceRedaction(
  serviceSlug: string | null | undefined,
  skillId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const baseline = redactSensitiveValue(data) as Record<string, unknown>;
  if (!serviceSlug) return baseline;
  const module = getService(serviceSlug);
  const hook = module?.security?.redactSensitiveFields;
  if (!hook) return baseline;
  try {
    return redactSensitiveValue(hook.call(module, skillId, data)) as Record<string, unknown>;
  } catch (err) {
    logError("redactSensitiveFields threw — replacing payload with stub", {
      serviceSlug,
      skillId,
      error: (err as Error).message,
    });
    return { "<redaction_error>": "payload withheld: redaction hook failed" };
  }
}
