import { existsSync, readFileSync } from "node:fs";

const path = ".agents/skills/daski-provider/SKILL.md";
const source = readFileSync(path, "utf8")
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n");
const failures = [];
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
if (!frontmatter) failures.push("SKILL.md must contain YAML frontmatter");
else {
  for (const required of [
    "name: daski-provider",
    "description:",
    "license: MIT",
    'version: "',
  ]) {
    if (!frontmatter.includes(required)) failures.push(`frontmatter missing: ${required}`);
  }
}
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (!frontmatter?.includes(`version: "${packageVersion}"`)) {
  failures.push("skill version must equal package.json version");
}
if (source.split("\n").length > 180) failures.push("SKILL.md should remain a thin router");
for (const required of [
  "AGENTS.md", "docs/getting-started.md", "docs/integrating-existing-product.md",
  "docs/adding-a-service.md", "docs/onboarding.md", "provider-full",
]) {
  if (!source.includes(required)) failures.push(`skill is missing route: ${required}`);
  if (required.endsWith(".md") && !existsSync(required)) failures.push(`missing ${required}`);
}
for (const forbidden of ["TODO", "TBD", "Documentation unavailable"]) {
  if (source.includes(forbidden)) failures.push(`skill contains unfinished marker: ${forbidden}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Daski provider skill validation passed\n");
