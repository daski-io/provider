import { decryptString, encryptString } from "../chain/encryption.js";

export type ProtectedEscalationField =
  | "question"
  | "response"
  | "agent_recommendation"
  | "resolution_error";

function context(id: string, field: ProtectedEscalationField) {
  return {
    purpose: "operator-escalation",
    table: "escalations",
    recordId: id,
    field,
    service: "core",
  } as const;
}

export function protectEscalationText(
  id: string,
  field: ProtectedEscalationField,
  value: string | null | undefined,
): string | null {
  return value ? encryptString(value, context(id, field)) : null;
}

export function revealEscalationText(
  id: string,
  field: ProtectedEscalationField,
  value: string | null | undefined,
): string | null {
  return value ? decryptString(value, context(id, field)) : null;
}

export function revealEscalationFields<T extends {
  id: string;
  question: string;
  response: string | null;
  agent_recommendation: string | null;
  resolution_error?: string | null;
}>(row: T): T {
  return {
    ...row,
    question: revealEscalationText(row.id, "question", row.question) ?? "",
    response: revealEscalationText(row.id, "response", row.response),
    agent_recommendation: revealEscalationText(
      row.id,
      "agent_recommendation",
      row.agent_recommendation,
    ),
    ...(Object.hasOwn(row, "resolution_error")
      ? {
          resolution_error: revealEscalationText(
            row.id,
            "resolution_error",
            row.resolution_error,
          ),
        }
      : {}),
  };
}
