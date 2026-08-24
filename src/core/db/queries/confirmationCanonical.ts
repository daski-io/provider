const MAX_CANONICAL_ARGUMENT_BYTES = 64 * 1024;
const MAX_CANONICAL_ARGUMENT_DEPTH = 20;
const MAX_CANONICAL_ARGUMENT_NODES = 10_000;
const FORBIDDEN_ARGUMENT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

interface CanonicalizationState {
  nodes: number;
  rawStringBytes: number;
  ancestors: Set<object>;
}

function accountRawString(value: string, state: CanonicalizationState): void {
  state.rawStringBytes += Buffer.byteLength(value, "utf8");
  if (state.rawStringBytes > MAX_CANONICAL_ARGUMENT_BYTES) {
    throw new Error("confirmation arguments exceed the size limit");
  }
}

function canonicalize(
  value: unknown,
  state: CanonicalizationState,
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_ARGUMENT_NODES) {
    throw new Error("confirmation arguments exceed the node limit");
  }
  if (depth > MAX_CANONICAL_ARGUMENT_DEPTH) {
    throw new Error("confirmation arguments exceed the depth limit");
  }
  if (typeof value === "string") {
    accountRawString(value, state);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("confirmation arguments must contain finite JSON numbers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("confirmation arguments must contain only JSON values");
  }
  if (state.ancestors.has(value)) {
    throw new Error("confirmation arguments must not contain cycles");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) return canonicalizeArray(value, state, depth);
    return canonicalizeObject(value, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalizeArray(
  value: unknown[],
  state: CanonicalizationState,
  depth: number,
): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("confirmation arguments must contain only standard JSON arrays");
  }
  if (value.length > MAX_CANONICAL_ARGUMENT_NODES) {
    throw new Error("confirmation arguments exceed the node limit");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error("confirmation arguments must not contain symbol keys");
  }
  if (ownKeys.filter((key) => key !== "length").length !== value.length) {
    throw new Error("confirmation arrays must not contain extra properties");
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("confirmation arguments must not contain sparse arrays");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("confirmation arrays must contain only data properties");
    }
    output.push(canonicalize(descriptor.value, state, depth + 1));
  }
  Object.setPrototypeOf(output, null);
  return output;
}

function canonicalizeObject(
  value: object,
  state: CanonicalizationState,
  depth: number,
): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("confirmation arguments must contain only standard JSON objects");
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error("confirmation arguments must not contain symbol keys");
  }
  for (const key of (ownKeys as string[]).sort()) {
    if (FORBIDDEN_ARGUMENT_KEYS.has(key)) {
      throw new Error(`confirmation arguments contain forbidden key '${key}'`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("confirmation objects must contain only enumerable data properties");
    }
    accountRawString(key, state);
    if (descriptor.value === undefined) {
      throw new Error("confirmation arguments must not contain undefined values");
    }
    output[key] = canonicalize(descriptor.value, state, depth + 1);
  }
  return output;
}

export function canonicalActionArguments(value: Record<string, unknown>): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("confirmation arguments must be a standard JSON object");
  }
  const canonical = JSON.stringify(canonicalize(value, {
    nodes: 0,
    rawStringBytes: 0,
    ancestors: new Set(),
  }, 0));
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_ARGUMENT_BYTES) {
    throw new Error("confirmation arguments exceed the size limit");
  }
  return canonical;
}
