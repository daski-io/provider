export function doctorSummary(
  checks: ReadonlyArray<{ status: string }>,
  database: "not_performed" | "performed" | "unavailable",
): string;
