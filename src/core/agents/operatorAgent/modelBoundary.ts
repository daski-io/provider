import {
  redactSensitiveText,
  redactSensitiveValue,
} from "../../security/redaction.js";

const MAX_MODEL_TEXT_CHARS = 16_000;
const NAME_KEY = /^(?:name|alias|aka|query)$/i;

function redactNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNames);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = NAME_KEY.test(key)
      ? `<redacted:${key}>`
      : redactNames(child);
  }
  return output;
}

/** Minimize decrypted chat/tool data immediately before an external LLM call. */
export function protectModelText(text: string | null): string | null {
  if (text === null) return null;
  let protectedText: string;
  try {
    const parsed: unknown = JSON.parse(text);
    protectedText = JSON.stringify(
      redactNames(redactSensitiveValue(parsed)),
    );
  } catch {
    protectedText = redactSensitiveText(text);
  }
  return protectedText.slice(0, MAX_MODEL_TEXT_CHARS);
}

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function protectModelToolCalls(
  calls: ModelToolCall[] | null | undefined,
): ModelToolCall[] | undefined {
  if (!calls?.length) return undefined;
  return calls.map((call) => ({
    ...call,
    function: {
      name: call.function.name,
      arguments: protectModelText(call.function.arguments) ?? "{}",
    },
  }));
}
