import { runDiagnostics } from "./doctor/diagnostics.mjs";
import {
  buildReport,
  helpText,
  parseDoctorArgs,
  renderHuman,
} from "./doctor/report.mjs";

try {
  const options = parseDoctorArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
  } else {
    const checks = await runDiagnostics(options);
    const report = buildReport(options.stage, checks);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report),
    );
    if (!report.ok) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "doctor failed";
  process.stderr.write(`Daski provider doctor: ${message}\n`);
  process.exitCode = 2;
}
