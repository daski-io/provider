import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|URL|ARTIFACT|OUTCOMES_JSON|ADMISSION_JSON|CATALOG_JSON)/i;

export function result(code, status, summary, detail) {
  return { code, status, summary, ...(detail ? { detail } : {}) };
}

export function isPlaceholder(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  return /REPLACE_|example\.invalid|YOUR_(?:PUBLIC_)?PROVIDER/i.test(value);
}

export function redactDiagnosticMessage(error, env = process.env) {
  let message = error instanceof Error ? error.message : "diagnostic failed";
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted-32-byte-value]");
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !value || value.length < 4) continue;
    message = message.replaceAll(value, `[redacted-${name.toLowerCase()}]`);
  }
  return message.slice(0, 2_000);
}

export function normalizedOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.username || url.password ? null : url.origin;
  } catch {
    return null;
  }
}
