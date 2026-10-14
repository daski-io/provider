/**
 * The gateway's passive-output rule for every provider answer it relays to a
 * buyer (daski-io/gateway src/standardRail/providerOutput.ts): no active web
 * content in any string, no control character other than tab, line feed and
 * carriage return, no unsafe key, and bounded depth and size. The gateway
 * refuses an artifact read that breaks it, so core never freezes such a
 * result as completed, and a service can decline such input before payment.
 */
const ACTIVE_CONTENT = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|<\s*\/?\s*(?:script|iframe|object|embed|form|meta|link|style)\b|\bon[a-z]+\s*=/iu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 32;
const MAX_NODES = 100_000;

/** Whether one string may appear in an answer the gateway relays. */
export function isPassiveText(value: string): boolean {
  return !ACTIVE_CONTENT.test(value) && !CONTROL_CHARACTERS.test(value);
}

/** Whether a whole JSON value passes the gateway's passive-output rule. */
export function isPassiveOutput(value: unknown): boolean {
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return false;
    if (typeof current === "string") return isPassiveText(current);
    if (current === null || typeof current === "boolean" || typeof current === "number") return true;
    if (Array.isArray(current)) return current.every((item) => visit(item, depth + 1));
    if (typeof current !== "object") return false;
    return Object.entries(current).every(([key, item]) => !UNSAFE_KEYS.has(key) && visit(item, depth + 1));
  };
  return visit(value, 0);
}
