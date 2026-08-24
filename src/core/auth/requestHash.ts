import { keccak256, toBytes, type Hex } from "viem";

const MAX_CANONICAL_JSON_BYTES = 1_000_000;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 50_000;
const FORBIDDEN_CANONICAL_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Deterministically serializes plain JSON with recursively sorted object keys.
 * Ambiguous or non-JSON inputs are rejected before any request is authorized.
 */
export function canonicalJsonStringify(value: unknown): string {
  const state = { nodes: 0, ancestors: new Set<object>() };
  const encoded = JSON.stringify(canonicalize(value, state, 0));
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_JSON_BYTES) {
    throw new Error("canonical JSON exceeds the size limit");
  }
  return encoded;
}

function canonicalize(
  value: unknown,
  state: { nodes: number; ancestors: Set<object> },
  depth: number,
): unknown {
  if (++state.nodes > MAX_CANONICAL_JSON_NODES) {
    throw new Error("canonical JSON exceeds the node limit");
  }
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new Error("canonical JSON exceeds the depth limit");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("canonical JSON contains a non-JSON value");
  }
  if (state.ancestors.has(value)) {
    throw new Error("canonical JSON must not contain cycles");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new Error("canonical JSON must not contain sparse arrays");
        }
      }
      return value.map((entry) => canonicalize(entry, state, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON must contain only plain objects");
    }
    const obj = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      if (FORBIDDEN_CANONICAL_KEYS.has(key)) {
        throw new Error(`canonical JSON contains forbidden key '${key}'`);
      }
      if (obj[key] === undefined) {
        throw new Error("canonical JSON must not contain undefined values");
      }
      sorted[key] = canonicalize(obj[key], state, depth + 1);
    }
    return sorted;
  } finally {
    state.ancestors.delete(value);
  }
}

export function computeRequestHash(value: Record<string, unknown>): Hex {
  return keccak256(toBytes(canonicalJsonStringify(value ?? {})));
}
