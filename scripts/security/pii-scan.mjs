import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "dist");
if (!existsSync(target)) throw new Error(`scan target does not exist: ${target}`);

const forbiddenNames = /(?:^|[\\/])(?:\.env(?:\..+)?|fixtures|captures|\.claude)(?:[\\/]|$)/i;
const forbiddenReportName = /(?:security[-_]audit|implementation[-_]report|audit[-_]\d{4})/i;
const patterns = [
  ["US social-security number", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["unredacted API/private key", /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{24,}\b/g],
];
const failures = [];

function walk(path) {
  return readdirSync(path).flatMap((name) => {
    const absolute = join(path, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

for (const file of walk(target)) {
  const display = relative(target, file);
  if (forbiddenNames.test(file) || forbiddenReportName.test(basename(file))) {
    failures.push(`${display}: forbidden captured-data/report path`);
    continue;
  }
  const stat = statSync(file);
  if (stat.size > 10_000_000) continue;
  const content = readFileSync(file, "utf8");
  if (
    /core\/db\/queries\/confirmation[^/]*\.js$/.test(display.replaceAll("\\", "/"))
    && /\bpending_payload\b/.test(content)
  ) {
    failures.push(`${display}: retired plaintext confirmation payload fallback`);
  }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) failures.push(`${display}: ${label}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`protected artifact scan passed: ${target}\n`);
