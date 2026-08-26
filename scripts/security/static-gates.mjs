import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), "utf8");
const projectPath = (path) => relative(root, path).replaceAll("\\", "/");

function files(path) {
  return readdirSync(path).flatMap((name) => {
    const absolute = join(path, name);
    return statSync(absolute).isDirectory() ? files(absolute) : [absolute];
  });
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.private !== true) failures.push("package must remain private");
if (packageJson.engines?.node !== ">=24.0.0 <25") {
  failures.push("runtime must remain pinned to Node 24");
}
const coverageConfig = read("vitest.config.ts");
for (const [metric, floor] of Object.entries({
  statements: 50.3,
  branches: 51.9,
  functions: 54.1,
  lines: 51.7,
})) {
  const configured = Number(
    new RegExp(`\\b${metric}:\\s*([0-9.]+)`).exec(coverageConfig)?.[1],
  );
  if (!Number.isFinite(configured) || configured < floor) {
    failures.push(`${metric} coverage threshold is below the reviewed baseline`);
  }
}
for (const dependency of ["@signinwithethereum/siwe", "cors", "openai"]) {
  if (packageJson.dependencies?.[dependency]) {
    failures.push(`full-only dependency is present: ${dependency}`);
  }
}
if (
  !packageJson.scripts.dev.includes("src/bootstrap.ts")
  || !packageJson.scripts.start.includes("dist/bootstrap.js")
) failures.push("runtime entrypoints must use bootstrap");

for (const path of [
  "src/core/admin", "src/core/email", "src/core/a2a", "src/core/llm",
  "src/core/engine", "src/core/assets", "src/providerExtensions",
  "src/providerScreening.ts", "src/rotateProtectedData.ts",
]) {
  if (existsSync(join(root, path))) failures.push(`full-only path is present: ${path}`);
}

const migrationFiles = readdirSync(join(root, "src/core/db/migrations"))
  .filter((name) => name.endsWith(".sql"));
if (migrationFiles.length !== 1 || migrationFiles[0] !== "001_initial.sql") {
  failures.push("minimal provider must ship one fresh baseline migration");
}
const migration = read("src/core/db/migrations/001_initial.sql");
for (const required of [
  "provider_transactions", "standard_evidence_admissions",
  "supplier_operations", "rate_limit_buckets",
]) {
  if (!migration.includes(required)) failures.push(`baseline missing ${required}`);
}
for (const forbidden of ["customers", "emails", "assets", "admin_sessions", "durable_jobs"]) {
  if (new RegExp(`CREATE TABLE\\s+${forbidden}\\b`, "i").test(migration)) {
    failures.push(`full-only table is present: ${forbidden}`);
  }
}

const server = read("src/core/server.ts");
for (const forbidden of ["/admin", "/webhooks", "/a2a", "/lifecycle", "/assets/"]) {
  if (server.includes(forbidden)) failures.push(`server exposes full-only route: ${forbidden}`);
}
const adapter = read("src/core/serviceRegistry/adapterTypes.ts");
for (const forbidden of ['"working"', '"input-required"', "handleInput(", "cancel("]) {
  if (adapter.includes(forbidden)) failures.push(`adapter exposes full-only state: ${forbidden}`);
}
if (!adapter.includes("signal: AbortSignal")) {
  failures.push("synchronous adapter must receive an abort signal");
}
const serviceModule = read("src/core/serviceRegistry/serviceModule.ts");
if (!serviceModule.includes("readiness(signal: AbortSignal)")) {
  failures.push("every service must expose bounded product readiness");
}
if (!server.includes("await providerReady()")) {
  failures.push("paid routes must use complete provider readiness");
}

const sourceFiles = files(join(root, "src"))
  .filter((file) => extname(file) === ".ts" && !file.includes("/tests/"));
for (const file of sourceFiles) {
  const path = projectPath(file);
  const source = readFileSync(file, "utf8");
  if (/\bconsole\.(?:log|info|warn|error|debug)\s*\(/.test(source)) {
    failures.push(`${path} bypasses the centralized logger`);
  }
  const imports = [...source.matchAll(/\b(?:from\s+|import\s*\()[\"']([^\"']+)[\"']/g)]
    .map((match) => match[1]);
  if (path.startsWith("src/core/") && imports.some((value) => value.includes("/services/"))) {
    failures.push(`${path} crosses the core-to-service boundary`);
  }
  if (
    path.startsWith("src/services/")
    && !path.includes("/tests/")
    && /\bfetch\s*\(/.test(source)
  ) failures.push(`${path} calls fetch directly; use boundedFetch`);
}

function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.slice(0, -3) + ".ts"]
    : [base, `${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const byPath = new Set(sourceFiles.map((file) => resolve(file)));
const reachable = new Set();
const queue = [
  "src/bootstrap.ts",
  "src/core/standardRail/offerCli.ts",
  "src/core/security/outboundHttp.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/suppliers/operationJournal.ts",
].map((path) => resolve(root, path));
while (queue.length) {
  const file = queue.pop();
  if (!file || reachable.has(file) || !byPath.has(file)) continue;
  reachable.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:from\s+|import\s*\()[\"']([^\"']+)[\"']/g)) {
    const imported = resolveImport(file, match[1]);
    if (imported) queue.push(imported);
  }
}
for (const file of sourceFiles) {
  if (!reachable.has(resolve(file))) failures.push(`unreachable source file: ${projectPath(file)}`);
}

if (!/^\* text=auto eol=lf\s*$/m.test(read(".gitattributes"))) {
  failures.push("text files must be normalized to LF");
}
const dockerfile = read("Dockerfile");
if (!/node:24-bookworm-slim@sha256:[0-9a-f]{64}/.test(dockerfile)) {
  failures.push("Dockerfile must pin the Node image digest");
}
if (!/^USER\s+node$/m.test(dockerfile)) failures.push("container must run as node");
if (!/^CMD \["node", "dist\/bootstrap\.js"\]$/m.test(dockerfile)) {
  failures.push("container must start the sanitized bootstrap");
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("minimal architecture and security gates passed\n");
