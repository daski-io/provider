import type { QuoteError } from "../../core/serviceRegistry/types.js";

// Input validation shared by quote() and the skill executors. quote() runs
// BEFORE any payment challenge is issued, so buyer mistakes surface while
// correcting them is free; the executors re-validate because an adapter
// must never trust that the quote path ran.

export const TITLE_MAX = 80;
export const BODY_MAX = 2_000;
export const MESSAGE_MAX = 500;

/// Canonical note identifier: kebab-case of the title. "Launch Checklist!"
/// → "launch-checklist". Deterministic so the buyer can re-derive it.
export function noteIdentifierFromTitle(title: string): string | null {
  const identifier = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return identifier.length > 0 ? identifier : null;
}

export function validateTitle(value: unknown): { ok: true; identifier: string } | { ok: false; error: QuoteError } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      error: { field: "title", code: "missing", message: "title is required" },
    };
  }
  if (value.length > TITLE_MAX) {
    return {
      ok: false,
      error: {
        field: "title",
        code: "too_long",
        message: `title must be at most ${TITLE_MAX} characters`,
      },
    };
  }
  const identifier = noteIdentifierFromTitle(value);
  if (!identifier) {
    return {
      ok: false,
      error: {
        field: "title",
        code: "invalid",
        message: "title must contain at least one letter or digit",
      },
    };
  }
  return { ok: true, identifier };
}

export function validateBody(value: unknown): QuoteError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return { field: "body", code: "invalid", message: "body must be a string" };
  }
  if (value.length > BODY_MAX) {
    return {
      field: "body",
      code: "too_long",
      message: `body must be at most ${BODY_MAX} characters`,
    };
  }
  return null;
}

export function validateMessage(value: unknown): QuoteError | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { field: "message", code: "missing", message: "message is required" };
  }
  if (value.length > MESSAGE_MAX) {
    return {
      field: "message",
      code: "too_long",
      message: `message must be at most ${MESSAGE_MAX} characters`,
    };
  }
  return null;
}
