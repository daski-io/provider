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
if (!packageJson.scripts["daski:install-runtime"]?.includes("src/installRuntimeBundle.ts")) {
  failures.push("minimal provider must expose the reviewed runtime-bundle installer");
}

for (const path of [
  "src/core/admin", "src/core/email", "src/core/a2a", "src/core/llm",
  "src/core/engine", "src/core/assets", "src/providerExtensions",
  "src/providerScreening.ts", "src/rotateProtectedData.ts",
]) {
  if (existsSync(join(root, path))) failures.push(`full-only path is present: ${path}`);
}
const gatewayRegistrationFiles = files(join(root, "src/core/gatewayRegistration"))
  .map(projectPath);
for (const path of gatewayRegistrationFiles) {
  if (!["src/core/gatewayRegistration/runtimeCatalog.ts",
    "src/core/gatewayRegistration/runtimeCommitment.ts",
    "src/core/gatewayRegistration/commitmentDrift.ts",
    "src/core/gatewayRegistration/commitmentDriftBoot.ts",
    "src/core/gatewayRegistration/types.ts"].includes(path)) {
    failures.push(`full registration surface is present: ${path}`);
  }
}

// Append-only migration boundary: exactly these reviewed files, in order, each
// creating exactly its listed tables. A new migration must be added here, and
// every table it creates must be reviewed into the runtime privilege list.
const REVIEWED_MIGRATIONS = [
  ["001_initial.sql", [
    "provider_transactions", "standard_evidence_admissions", "supplier_operations",
    "rate_limit_buckets", "provider_runtime_listing_versions",
  ]],
  ["002_provider_quotes.sql", ["provider_quotes"]],
  ["003_dispatch_admission.sql", []],
  ["004_terminal_identity.sql", []],
  ["005_runtime_epoch_barrier.sql", ["provider_schema_epoch"]],
  ["006_sync_execution_leases.sql", []],
  ["007_quote_retention.sql", []],
  ["008_async_admission.sql", ["provider_async_admission", "provider_runtime_instances"]],
  ["009_external_jobs.sql", ["provider_external_jobs"]],
];
const migrationFiles = readdirSync(join(root, "src/core/db/migrations"))
  .filter((name) => name.endsWith(".sql")).sort();
if (JSON.stringify(migrationFiles) !== JSON.stringify(REVIEWED_MIGRATIONS.map(([name]) => name))) {
  failures.push("migrations must match the reviewed append-only allowlist");
}
const migratedTables = [];
for (const [name, tables] of REVIEWED_MIGRATIONS) {
  if (!existsSync(join(root, "src/core/db/migrations", name))) continue;
  const migration = read(`src/core/db/migrations/${name}`);
  const created = [...migration.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
  )].map((match) => match[1].toLowerCase());
  if (JSON.stringify([...created].sort()) !== JSON.stringify([...tables].sort())) {
    failures.push(`${name} must create exactly: ${tables.join(", ") || "no tables"}`);
  }
  migratedTables.push(...created);
  for (const forbidden of ["customers", "emails", "assets", "admin_sessions", "durable_jobs"]) {
    if (created.includes(forbidden)) failures.push(`full-only table is present: ${forbidden}`);
  }
  // TRUNCATE is refused as a statement; trigger event lists may name it.
  if (/\b(?:DROP\s+TABLE|DELETE\s+FROM)\b|(?:^|;)\s*TRUNCATE\b/im.test(migration)) {
    failures.push(`${name} must not drop or erase durable state`);
  }
}
// Legacy-process barrier (005): every table a migration creates, and the
// runner's ledger, carries the statement-level runtime-epoch trigger.
const allMigrations = REVIEWED_MIGRATIONS
  .filter(([name]) => existsSync(join(root, "src/core/db/migrations", name)))
  .map(([name]) => read(`src/core/db/migrations/${name}`)).join("\n");
for (const table of ["_migrations", ...migratedTables]) {
  const trigger = new RegExp(
    `CREATE\\s+TRIGGER\\s+${table}_runtime_epoch\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE`
    + `\\s+OR\\s+TRUNCATE\\s+ON\\s+${table}\\s+FOR\\s+EACH\\s+STATEMENT\\s+EXECUTE\\s+FUNCTION`
    + `\\s+provider_runtime_epoch_barrier\\(\\)`,
    "i",
  );
  if (!trigger.test(allMigrations)) {
    failures.push(`${table} must carry the runtime-epoch barrier trigger`);
  }
}
const privilegeSource = read("src/core/db/runtimePrivileges.ts");
const privilegeBlock = /RUNTIME_TABLE_PRIVILEGES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(privilegeSource)?.[1] ?? "";
const reviewedTables = [...privilegeBlock.matchAll(/^\s+([a-z_][a-z0-9_]*):\s*\[/gm)]
  .map((match) => match[1]);
if (JSON.stringify([...reviewedTables].sort()) !== JSON.stringify([...migratedTables].sort())) {
  failures.push("runtime privileges must review exactly the migrated tables");
}

// C01: the gateway rejects compressed provider answers, so no compression
// middleware may be installed anywhere in the HTTP stack.
if (packageJson.dependencies?.compression || packageJson.devDependencies?.compression) {
  failures.push("response compression is forbidden");
}
const server = read("src/core/server.ts");
if (/\bcompression\s*\(|content-encoding/i.test(server)) {
  failures.push("server must not compress or encode responses");
}
for (const forbidden of ["/admin", "/webhooks", "/a2a", "/assets/"]) {
  if (server.includes(forbidden)) failures.push(`server exposes full-only route: ${forbidden}`);
}
// Explicit standard-rail boundary: exactly these routes, and exactly the
// funded-order servicing calls exempt from sales readiness and purchase
// limits. The lifecycle route serves status and artifact reads only; it never
// reaches a product adapter.
const REVIEWED_RAIL_ROUTES = [
  "GET /outcomes", "POST /quote", "POST /dispatch", "POST /dispatch/status", "POST /lifecycle",
];
const railRoutes = read("src/core/standardRail/routes.ts");
const declaredRailRoutes = [...railRoutes.matchAll(
  /\brouter\.(get|post|put|patch|delete|all|use)\(\s*"([^"]*)"/g,
)].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
if (JSON.stringify(declaredRailRoutes.sort()) !== JSON.stringify([...REVIEWED_RAIL_ROUTES].sort())) {
  failures.push(`standard-rail routes must be exactly: ${REVIEWED_RAIL_ROUTES.join(", ")}`);
}
const servicingMarks = [...read("src/core/security/servicingIngress.ts").matchAll(
  /\bapp\.(\w+)\(\s*"([^"]*)",\s*mark\(/g,
)].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
if (JSON.stringify(servicingMarks.sort()) !== JSON.stringify([
  "POST /standard-rail/dispatch", "POST /standard-rail/dispatch/status", "POST /standard-rail/lifecycle",
])) failures.push("servicing calls must be exactly dispatch, dispatch status and lifecycle");
for (const path of [
  "src/core/standardRail/lifecycle.ts", "src/core/standardRail/lifecycleRequest.ts",
]) {
  const source = read(path);
  if (/serviceRegistry\/registry|getAdapter|\.execute\(|supplier/.test(source)) {
    failures.push(`${path} must not reach a product adapter`);
  }
}
// External-job runtime (L09): exactly these lite modules, no full-starter
// workflow. Only the worker's bounded call runner invokes an external-job
// adapter; the HTTP paths admit, answer and read jobs without one, so
// dispatch commits before any upstream call and status and lifecycle reads
// stay one database read.
const REVIEWED_EXTERNAL_JOB_MODULES = [
  "admission.ts", "calls.ts", "idempotency.ts", "jobClaims.ts", "jobCodec.ts", "jobStep.ts",
  "jobTransitions.ts", "journalHandoff.ts", "keyRing.ts", "outcomes.ts", "phases.ts", "runtime.ts", "sales.ts",
  "scheduling.ts", "servicing.ts", "settings.ts", "stepSupport.ts", "worker.ts",
].map((name) => `src/core/externalJobs/${name}`);
const externalJobModules = files(join(root, "src/core/externalJobs")).map(projectPath).sort();
if (JSON.stringify(externalJobModules) !== JSON.stringify([...REVIEWED_EXTERNAL_JOB_MODULES].sort())) {
  failures.push(`external-job modules must be exactly: ${REVIEWED_EXTERNAL_JOB_MODULES.join(", ")}`);
}
for (const file of files(join(root, "src/core"))) {
  const path = projectPath(file);
  if (path === "src/core/externalJobs/calls.ts" || extname(file) !== ".ts") continue;
  if (/\.(?:start|recoverStart|poll)\s*\(/.test(readFileSync(file, "utf8"))) {
    failures.push(`${path} must not call an external-job adapter; only externalJobs/calls.ts does`);
  }
}
// The service adapter API: exactly the two reviewed modes and the reviewed
// external-job outcome kinds. Adapters never name a wire state or a
// full-only lifecycle action (later input, cancellation).
const adapter = read("src/core/serviceRegistry/adapterTypes.ts");
for (const forbidden of [
  '"submitted"', '"working"', '"input-required"', '"canceled"', "handleInput(", "cancel(",
]) {
  if (adapter.includes(forbidden)) failures.push(`adapter exposes full-only state: ${forbidden}`);
}
const literals = (pattern) => [...new Set([...adapter.matchAll(pattern)].map((match) => match[1]))].sort();
if (JSON.stringify(literals(/\bmode\??:\s*"([^"]+)"/g)) !== JSON.stringify(["external-job", "sync"])) {
  failures.push("adapter modes must be exactly sync and external-job");
}
if (JSON.stringify(literals(/\bkind:\s*"([^"]+)"/g)) !== JSON.stringify([
  "accepted", "ambiguous", "pending", "retry", "safe-to-start", "terminal", "unknown",
])) failures.push("external-job outcome kinds must be exactly the reviewed set");
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
// The reviewed example roots: the synthetic external-job service is a
// Testnet-only copy-from example that providerServices.ts does not compose;
// tests and the offline tour (npm run try-skill) build it.
const REVIEWED_EXAMPLE_ROOTS = [
  "src/services/synthetic-audit/index.ts",
  "src/services/synthetic-audit/tour.ts",
];
const queue = [
  "src/bootstrap.ts",
  "src/installRuntimeBundle.ts",
  "src/upgradeCutover.ts",
  "src/activateAsyncAdmission.ts",
  "src/core/security/outboundHttp.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/suppliers/operationJournal.ts",
  ...REVIEWED_EXAMPLE_ROOTS,
].map((path) => resolve(root, path));
if (/synthetic-audit/.test(read("src/providerServices.ts"))) {
  failures.push("the synthetic audit example must not be composed into the provider");
}
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

// The async-admission switch stays off through migrations, the importer and
// boot: only the operator's activation command reaches the module that
// writes it, and no other source writes the switch.
for (const file of sourceFiles) {
  const path = projectPath(file);
  const source = readFileSync(file, "utf8");
  if (
    path !== "src/activateAsyncAdmission.ts"
    && /asyncAdmissionActivation\.js/.test(source)
  ) failures.push(`${path} must not reach the async-admission activation`);
  if (
    path !== "src/core/standardRail/asyncAdmissionActivation.ts"
    && /UPDATE\s+provider_async_admission/i.test(source)
  ) failures.push(`${path} must not write the async-admission switch`);
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
