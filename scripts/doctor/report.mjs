const STAGES = new Set(["local", "testnet", "mainnet"]);

export function parseDoctorArgs(argv) {
  let stage = "local";
  let json = false;
  let live = false;
  let help = false;

  for (const argument of argv) {
    if (argument.startsWith("--stage=")) {
      stage = argument.slice("--stage=".length);
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--live") {
      live = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`unknown doctor option: ${argument}`);
    }
  }
  if (!STAGES.has(stage)) {
    throw new Error("--stage must be local, testnet, or mainnet");
  }
  return { stage, json, live, help };
}

export function helpText() {
  return [
    "Daski provider doctor (read-only)",
    "",
    "Usage:",
    "  npm run doctor",
    "  npm run doctor -- --stage=testnet",
    "  npm run doctor -- --stage=mainnet",
    "  npm run --silent doctor -- --stage=testnet --json",
    "  npm run doctor -- --stage=testnet --live",
    "",
    "--live adds bounded read-only provider-health and Base RPC probes.",
    "The database check always runs SELECT-only queries when DATABASE_URL is usable.",
  ].join("\n") + "\n";
}

export function buildReport(stage, checks) {
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    schemaVersion: 1,
    stage,
    ok: failures === 0,
    summary: {
      passed: checks.length - failures - warnings,
      warnings,
      failures,
    },
    checks,
  };
}

export function renderHuman(report) {
  const lines = [
    `Daski provider doctor — ${report.stage}`,
    "Read-only: no migrations, registration, chain writes, or supplier calls were run.",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.code} — ${check.summary}`);
    if (check.detail) {
      for (const detailLine of check.detail.split("\n")) {
        lines.push(`       ${detailLine}`);
      }
    }
  }
  lines.push("");
  if (!report.ok) {
    lines.push(
      `Result: not ready (${report.summary.failures} failure(s), ` +
        `${report.summary.warnings} warning(s)).`,
    );
  } else if (report.summary.warnings > 0) {
    lines.push(`Result: machine checks passed with ${report.summary.warnings} warning(s).`);
  } else {
    lines.push("Result: ready for the selected machine-verifiable stage.");
  }
  if (report.stage === "mainnet") {
    lines.push(
      "Mainnet still requires explicit Daski whitelisting and release approval; " +
        "doctor cannot grant either.",
    );
  }
  return lines.join("\n") + "\n";
}
