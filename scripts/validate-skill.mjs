import { existsSync, readFileSync } from "node:fs";
import {
  findEvaluationReferences,
  findRoutingContradictions,
  findUnknownAdapterReferences,
  readAdapterApi,
} from "./skill-rules.mjs";

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
if (source.split("\n").length > 180) {
  failures.push("SKILL.md should remain a concise router; move conditional detail to references");
}
let packagedSource = source;
const requiredReferences = [
  "references/daski-primer.md",
  "references/start-here.md",
  "references/integration-brief.md",
  "references/external-jobs.md",
  "references/provider-full.md",
  "references/onboarding-handoff.md",
];
for (const reference of requiredReferences) {
  const referencePath = `.agents/skills/daski-provider/${reference}`;
  if (!source.includes(reference)) failures.push(`skill is missing reference route: ${reference}`);
  if (!existsSync(referencePath)) {
    failures.push(`skill package is missing ${reference}`);
    continue;
  }
  const referenceSource = readFileSync(referencePath, "utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  packagedSource += `\n${referenceSource}`;
  if (referenceSource.trim().length < 200) failures.push(`${reference} is unexpectedly empty`);
  for (const forbidden of ["TODO", "TBD", "Documentation unavailable"]) {
    if (referenceSource.includes(forbidden)) {
      failures.push(`${reference} contains unfinished marker: ${forbidden}`);
    }
  }
}
for (const required of [
  "AGENTS.md", "docs/getting-started.md", "docs/integrating-existing-product.md",
  "docs/adding-a-service.md", "docs/onboarding.md", "provider-full",
]) {
  if (!packagedSource.includes(required)) failures.push(`skill package is missing route: ${required}`);
  if (required.endsWith(".md") && !existsSync(required)) failures.push(`missing ${required}`);
}
for (const forbidden of ["TODO", "TBD", "Documentation unavailable"]) {
  if (source.includes(forbidden)) failures.push(`skill contains unfinished marker: ${forbidden}`);
}

// One routing rule (the three paths), stated in the entrypoint and never
// contradicted anywhere in the package; examples name only adapter members
// and outcomes the checked-out source declares; nothing points at the
// evaluation briefs an installed copy lacks; no live endpoint.
for (const path of ["Lite synchronous", "Lite external job", "Full"]) {
  if (!new RegExp(`^\\| ${path} \\(`, "m").test(source)) failures.push(`SKILL.md path table is missing: ${path}`);
}
if (!packagedSource.includes("npx skills add https://github.com/daski-io/provider --skill daski-provider")) {
  failures.push("skill package must document the published install command");
}
const api = readAdapterApi(process.cwd());
const packaged = [path, ...requiredReferences.map((reference) => `.agents/skills/daski-provider/${reference}`)]
  .filter((file) => existsSync(file));
for (const file of packaged) {
  const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (const problem of findRoutingContradictions(text)) failures.push(`${file}: contradictory routing: ${problem}`);
  for (const problem of findUnknownAdapterReferences(text, api)) failures.push(`${file}: ${problem}`);
  for (const problem of findEvaluationReferences(text)) failures.push(`${file}: ${problem}`);
  for (const match of text.matchAll(/https?:\/\/[^\s)`>"']+/g)) {
    if (!/^https:\/\/(?:github\.com\/daski-io\/(?:provider|provider-full)(?:\.git)?|discord\.gg\/uyeMp7Q2HW|daski\.io|<[a-z-]+)(?:[/#?]|$)/.test(match[0])) {
      failures.push(`${file}: links outside Daski's public repositories and channels: ${match[0]}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Daski provider skill validation passed\n");
