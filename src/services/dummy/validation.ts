import { isPassiveText, type RequestFieldError } from "../../core/serviceRegistry/types.js";

export function parseMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("message must be a string");
  const message = value.trim();
  const length = [...message].length;
  if (length < 1 || length > 500) {
    throw new Error("message must contain between 1 and 500 Unicode code points");
  }
  return message;
}

/**
 * Field errors for a schema-valid request the echo could not deliver: a
 * message that is empty once trimmed, or one the gateway would refuse to
 * relay as passive output. Declining before payment avoids a paid failure.
 */
export function messageFieldErrors(input: Record<string, unknown>): RequestFieldError[] {
  let message: string;
  try {
    message = parseMessage(input.message);
  } catch {
    return [{
      path: "message",
      rule: "min-length",
      message: "The message must contain 1 to 500 Unicode code points after trimming.",
    }];
  }
  if (isPassiveText(message)) return [];
  return [{
    path: "message",
    rule: "passive-text",
    message: "The message must not contain markup, script URLs, event-handler attributes or control characters.",
  }];
}
