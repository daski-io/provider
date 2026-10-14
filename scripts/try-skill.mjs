const [service = "dummy", skill = "echo", ...words] = process.argv.slice(2);

if (service === "dummy" && skill === "echo") {
  const { DummyAdapter } = await import("../src/services/dummy/adapter.ts");
  const result = await new DummyAdapter().execute({
    taskId: "offline-demo",
    orderId: "offline-demo",
    payer: "0x0000000000000000000000000000000000000001",
    serviceSlug: "dummy",
    skillId: "echo",
    signal: new AbortController().signal,
  }, { message: words.join(" ") || "hello daski" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (service === "synthetic-audit" && skill === "audit") {
  // External-job tour: fake clock and in-memory product, no wallet, database,
  // chain or network.
  const { runSyntheticAuditTour } = await import("../src/services/synthetic-audit/tour.ts");
  const tour = await runSyntheticAuditTour(words.join(" ") || "Audit the onboarding flow of a sample application");
  process.stdout.write(`${JSON.stringify(tour, null, 2)}\n`);
} else {
  process.stderr.write(
    "try-skill is intentionally limited to: npm run try-skill -- dummy echo [message]\n"
    + "                                    or: npm run try-skill -- synthetic-audit audit [description]\n",
  );
  process.exit(1);
}
