// Chat-completions parameter compatibility across OpenAI model families.
//
// The gpt-5.x family and the o-series reasoning models renamed the
// output-length cap from `max_tokens` to `max_completion_tokens` and
// reject a non-default `temperature`. The older gpt-4.x / gpt-3.5 chat
// models still use `max_tokens`. Our three tool-using / JSON call sites
// (Email Agent, Operator Agent, pre-execute JSON) each let ops pin a
// different model per env, so the param choice has to be derived from the
// model string at call time rather than hard-coded.
//
// Keeping the rule here means a single place to update when a new family
// lands, and one obvious thing to unit-test.

/// True when `model` belongs to a family that uses `max_completion_tokens`
/// (and rejects custom `temperature`): the gpt-5.x line (e.g.
/// `gpt-5.4-mini`) and the o-series reasoning models (`o1`, `o3-mini`, …).
export function usesCompletionTokensParam(model: string): boolean {
  const m = model.trim().toLowerCase();
  // gpt-5, gpt-5.4-mini, gpt-5o, … all start with "gpt-5".
  if (m.startsWith("gpt-5")) return true;
  // o-series: o1, o1-mini, o3, o3-mini, o4-mini, … — a bare "o" followed
  // by a digit. Guard against false-positives like "olmo" by requiring
  // the digit immediately after the leading "o".
  if (/^o\d/.test(m)) return true;
  return false;
}

/// Returns the correct output-length-cap parameter object for `model`,
/// spread directly into a chat.completions.create() call:
///   ...maxTokensParam(model, 800)
/// → `{ max_completion_tokens: 800 }` or `{ max_tokens: 800 }`.
export function maxTokensParam(
  model: string,
  limit: number,
): { max_completion_tokens: number } | { max_tokens: number } {
  return usesCompletionTokensParam(model)
    ? { max_completion_tokens: limit }
    : { max_tokens: limit };
}
