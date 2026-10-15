// The doctor's closing line. An offline pass says nothing about the
// database, so it is never summarized as ready.
export function doctorSummary(checks, database) {
  const failed = checks.filter((item) => item.status === "fail").length;
  if (failed > 0) return `Result: ${failed} blocking check(s).`;
  if (database === "not_performed") {
    return "Result: offline checks passed; database checks were not performed (add --database).";
  }
  return "Result: ready for the next documented step.";
}
