const PUBLIC_FAILURE_MESSAGES = {
  supplier: "The fulfillment supplier is temporarily unavailable. Please retry later.",
  chain: "The chain service is temporarily unavailable. Please retry later.",
  document: "The requested document is not currently available. Contact support if the issue persists.",
  fulfillment: "Fulfillment could not be completed. Contact support if the issue persists.",
} as const;

export type PublicFailureKind = keyof typeof PUBLIC_FAILURE_MESSAGES;

/** Returns a fixed customer-safe dependency failure without internal detail. */
export function publicFailureMessage(kind: PublicFailureKind): string {
  return PUBLIC_FAILURE_MESSAGES[kind];
}
