import { randomUUID } from "node:crypto";
import { errorExtra, logError } from "../../logger.js";

export function adminActionFailure(
  action: string,
  error: unknown,
): string {
  const reference = randomUUID();
  logError("Admin UI action failed", errorExtra(error, {
    action,
    reference,
  }));
  return `Action failed. Review platform logs with reference ${reference}.`;
}
