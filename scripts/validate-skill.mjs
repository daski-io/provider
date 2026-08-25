import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDirectory = join(ROOT, ".agents/skills/daski-provider");
const skillPath = join(skillDirectory, "SKILL.md");
const failures = [];
const source = (await readFile(skillPath, "utf8")).replace(/\r\n?/g, "\n");

const frontmatterMatch = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source);
if (!frontmatterMatch) {
  failures.push("SKILL.md must contain YAML frontmatter and a non-empty body");
} else {
  const frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];
  const topLevel = [...frontmatter.matchAll(/^([a-z][a-z0-9-]*):(?:\s*(.*))?$/gm)]
    .filter((match) => !match[0].startsWith(" "));
  const fields = new Map(topLevel.map((match) => [match[1], match[2]?.trim() ?? ""]));
  const allowed = new Set([
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
  ]);
  for (const field of fields.keys()) {
    if (!allowed.has(field)) failures.push(`unsupported skill frontmatter field: ${field}`);
  }
  if (fields.get("name") !== "daski-provider") {
    failures.push("skill name must be daski-provider");
  }
  const description = fields.get("description") ?? "";
  if (description.length < 80 || description.length > 1_024) {
    failures.push("skill description must be discriminating and 80-1024 characters");
  }
  if (fields.get("license") !== "MIT") failures.push("skill license must be MIT");
  if (!/^\s{2}version:\s+"1\.0\.0"\s*$/m.test(frontmatter)) {
    failures.push("skill metadata.version must be 1.0.0");
  }
  if (body.split(/\s+/).length > 1_600) {
    failures.push("skill is too large; detailed guidance belongs in repository docs");
  }
  for (const required of [
    "AGENTS.md",
    "docs/getting-started.md",
    "docs/integrating-existing-product.md",
    "docs/onboarding.md",
    "docs/troubleshooting.md",
    "npm run doctor",
    "npm run try-skill",
    "Daski whitelisting",
  ]) {
    if (!body.includes(required)) failures.push(`skill is missing required routing: ${required}`);
  }
  for (const nonPortable of [
    "disable-model-invocation",
    "${CLAUDE_SKILL_DIR}",
    "$ARGUMENTS",
    "!`",
  ]) {
    if (source.includes(nonPortable)) failures.push(`skill uses non-portable syntax: ${nonPortable}`);
  }
  if (/\b(?:TODO|TBD)\b/.test(source)) failures.push("skill contains an unfinished marker");
}

const entries = await readdir(skillDirectory, { withFileTypes: true });
if (entries.some((entry) => entry.name !== "SKILL.md")) {
  failures.push("instruction-only skill must not contain unreviewed bundled resources");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("daski-provider Agent Skill validation passed\n");
