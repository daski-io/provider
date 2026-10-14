import type { ErrorObject } from "ajv";
import type { RequestFieldError } from "../serviceRegistry/types.js";

/** The gateway reads at most this many field errors from a quote refusal. */
export const MAX_FIELD_ERRORS = 32;
const MAX_ALLOWED_VALUES = 16;
const RULE = /^[a-z][a-z0-9_.-]{0,63}$/;

const RULE_BY_KEYWORD: Readonly<Record<string, string>> = {
  additionalProperties: "unsupported-field",
  const: "const",
  enum: "enum",
  maxItems: "max-items",
  maxLength: "max-length",
  maxProperties: "max-properties",
  maximum: "maximum",
  minItems: "min-items",
  minLength: "min-length",
  minProperties: "min-properties",
  minimum: "minimum",
  pattern: "pattern",
  required: "required",
  type: "type",
};

function appendPath(path: string, segment: string): string {
  if (/^(0|[1-9]\d*)$/.test(segment)) return `${path}[${segment}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) return path ? `${path}.${segment}` : segment;
  return `${path}[${JSON.stringify(segment)}]`;
}

function errorPath(error: ErrorObject): string {
  const segments = error.instancePath
    ? error.instancePath.split("/").slice(1)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
  let path = segments.reduce(appendPath, "");
  const params = error.params as Record<string, unknown>;
  const property = error.keyword === "required" ? params.missingProperty
    : error.keyword === "additionalProperties" ? params.additionalProperty
      : undefined;
  if (typeof property === "string") path = appendPath(path, property);
  return (path || "$").slice(0, 256);
}

function schemaMessage(error: ErrorObject, path: string): string {
  const label = path === "$" ? "Request" : `Field '${path}'`;
  const params = error.params as Record<string, unknown>;
  const limit = typeof params.limit === "number" ? params.limit : null;
  switch (error.keyword) {
    case "required": return `${label} is required.`;
    case "additionalProperties": return `${label} is not accepted by the published request contract.`;
    case "type": return `${label} must be of type ${String(params.type ?? "published")}.`;
    case "enum": return `${label} must be one of the values published in the request contract.`;
    case "const": return `${label} must match the value published in the request contract.`;
    case "pattern": return `${label} must match the published pattern.`;
    case "minLength": return `${label} must contain at least ${limit ?? "the published"} characters.`;
    case "maxLength": return `${label} must contain at most ${limit ?? "the published"} characters.`;
    case "minimum": return `${label} must be at least ${limit ?? "the published minimum"}.`;
    case "maximum": return `${label} must be at most ${limit ?? "the published maximum"}.`;
    case "minItems": case "minProperties":
      return `${label} must contain at least ${limit ?? "the published number of"} entries.`;
    case "maxItems": case "maxProperties":
      return `${label} must contain at most ${limit ?? "the published number of"} entries.`;
    default: return `${label} does not match the published request contract.`;
  }
}

/// Field errors built only from schema-derived data: paths, keywords and the
/// published allowed values. Submitted values never appear.
export function schemaFieldErrors(errors: ErrorObject[] | null | undefined): RequestFieldError[] {
  return (errors ?? []).slice(0, MAX_FIELD_ERRORS).map((error) => {
    const path = errorPath(error);
    const allowed = (error.params as { allowedValues?: unknown }).allowedValues;
    const allowedValues = Array.isArray(allowed) && allowed.every((value) => typeof value === "string")
      ? allowed.slice(0, MAX_ALLOWED_VALUES) as string[]
      : undefined;
    return {
      path,
      rule: RULE_BY_KEYWORD[error.keyword] ?? "schema",
      message: schemaMessage(error, path),
      ...(error.keyword === "enum" && allowedValues ? { allowedValues } : {}),
    };
  });
}

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= maximum
  && [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f;
  });

/// Validate field errors returned by a service readiness hook. Anything
/// outside the reviewed shape makes the hook a fault (no quote), so service
/// text cannot become an unbounded or structured escape channel.
export function reviewedFieldErrors(value: unknown): RequestFieldError[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELD_ERRORS) return null;
  const reviewed: RequestFieldError[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item);
    if (keys.some((key) => !["path", "rule", "message", "allowedValues"].includes(key))) return null;
    if (!boundedText(item.path, 256) || typeof item.rule !== "string" || !RULE.test(item.rule)
      || !boundedText(item.message, 512)) return null;
    let allowedValues: string[] | undefined;
    if (item.allowedValues !== undefined) {
      if (
        !Array.isArray(item.allowedValues) || item.allowedValues.length > MAX_ALLOWED_VALUES
        || !item.allowedValues.every((allowed) => boundedText(allowed, 128))
      ) return null;
      allowedValues = [...item.allowedValues as string[]];
    }
    reviewed.push({
      path: item.path,
      rule: item.rule,
      message: item.message,
      ...(allowedValues ? { allowedValues } : {}),
    });
  }
  return reviewed;
}
