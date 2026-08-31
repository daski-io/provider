import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";

const skillName = "daski-provider";
const skillRoot = `.agents/skills/${skillName}`;
const entrypointPath = `${skillRoot}/SKILL.md`;
const canonicalSource = "https://github.com/daski-io/provider";
const conciseRouterLineLimit = 180;
const failures = [];

const requiredReferences = [
  "references/daski-primer.md",
  "references/start-here.md",
  "references/integration-brief.md",
  "references/provider-full.md",
  "references/onboarding-handoff.md",
];
const expectedEntries = [
  "SKILL.md",
  "references/",
  ...requiredReferences,
].sort();

function normalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function readText(path) {
  return normalizeLineEndings(readFileSync(path, "utf8"));
}

function collectEntries(directory, prefix = "") {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) {
      entries.push(`${relative}/`);
      entries.push(...collectEntries(absolute, relative));
    } else {
      entries.push(relative);
    }
  }
  return entries;
}

function parseStringScalar(raw, field) {
  const value = raw.trim();
  if (!value) {
    failures.push(`${field} must be a non-empty string`);
    return undefined;
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      failures.push(`${field} must be a valid quoted string`);
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      failures.push(`${field} must be a valid quoted string`);
      return undefined;
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (
    /^(?:null|~|true|false|yes|no|on|off)$/i.test(value)
    || /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)
    || /^[\[\]{}&*!|>]/.test(value)
  ) {
    failures.push(`${field} must be a string`);
    return undefined;
  }
  return value;
}

function parseFrontmatter(frontmatter) {
  const parsed = {};
  let activeMap;
  for (const [index, line] of frontmatter.split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) {
      failures.push(`frontmatter line ${index + 1} must not contain tabs`);
      continue;
    }
    if (/^\s/.test(line)) {
      const nested = /^  ([a-zA-Z0-9-]+):\s*(.*)$/.exec(line);
      if (!nested || activeMap !== "metadata") {
        failures.push(`unsupported frontmatter structure on line ${index + 1}`);
        continue;
      }
      const [, key, raw] = nested;
      if (Object.hasOwn(parsed.metadata, key)) {
        failures.push(`duplicate metadata field: ${key}`);
        continue;
      }
      parsed.metadata[key] = parseStringScalar(raw, `metadata.${key}`);
      continue;
    }

    const topLevel = /^([a-zA-Z0-9-]+):\s*(.*)$/.exec(line);
    if (!topLevel) {
      failures.push(`unsupported frontmatter syntax on line ${index + 1}`);
      continue;
    }
    const [, key, raw] = topLevel;
    if (Object.hasOwn(parsed, key)) {
      failures.push(`duplicate frontmatter field: ${key}`);
      continue;
    }
    activeMap = undefined;
    if (key === "metadata" && raw === "") {
      parsed.metadata = {};
      activeMap = "metadata";
    } else {
      parsed[key] = parseStringScalar(raw, key);
    }
  }
  return parsed;
}

const source = readText(entrypointPath);
const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/.exec(source);
if (!frontmatterMatch) failures.push("SKILL.md must contain YAML frontmatter");
const fields = frontmatterMatch ? parseFrontmatter(frontmatterMatch[1]) : {};

if (basename(resolve(skillRoot)) !== skillName) {
  failures.push(`skill directory must be named ${skillName}`);
}
if (fields.name !== skillName) failures.push(`name must equal ${skillName}`);
if (
  typeof fields.name === "string"
  && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64)
) {
  failures.push("name must satisfy the Agent Skills naming and length rules");
}
if (typeof fields.description !== "string") {
  failures.push("description must be present as a string");
} else if (fields.description.length < 1 || fields.description.length > 1024) {
  failures.push("description must contain 1-1024 characters");
}
if (fields.license !== "MIT") failures.push("license must equal MIT");
if (typeof fields.compatibility !== "string") {
  failures.push("compatibility must be present as a string");
} else if (fields.compatibility.length < 1 || fields.compatibility.length > 500) {
  failures.push("compatibility must contain 1-500 characters");
}
if (
  !fields.metadata
  || typeof fields.metadata !== "object"
  || Array.isArray(fields.metadata)
) {
  failures.push("metadata must be present as a string-to-string mapping");
} else {
  for (const [key, value] of Object.entries(fields.metadata)) {
    if (value !== undefined && typeof value !== "string") {
      failures.push(`metadata.${key} must be a string`);
    }
  }
  if (fields.metadata.author !== "daski-io") {
    failures.push("metadata.author must equal daski-io");
  }
  if (fields.metadata.source !== canonicalSource) {
    failures.push(`metadata.source must equal ${canonicalSource}`);
  }
  try {
    const sourceUrl = new URL(fields.metadata.source);
    if (
      sourceUrl.protocol !== "https:"
      || sourceUrl.username
      || sourceUrl.password
      || sourceUrl.search
      || sourceUrl.hash
    ) {
      failures.push("metadata.source must be a canonical HTTPS URL");
    }
  } catch {
    failures.push("metadata.source must be a valid HTTPS URL");
  }
}
if (Object.hasOwn(fields, "allowed-tools")) {
  failures.push("allowed-tools must remain absent so hosts retain normal approval behavior");
}

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (fields.metadata?.version !== packageVersion) {
  failures.push("skill version must equal package.json version");
}
if (source.split("\n").length > conciseRouterLineLimit) {
  failures.push(
    `SKILL.md exceeds the ${conciseRouterLineLimit}-line concise-router limit; move conditional detail to references`,
  );
}

const actualEntries = collectEntries(skillRoot).sort();
if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
  failures.push(
    `skill package entries must be exactly:\n${expectedEntries.join("\n")}\nactual:\n${actualEntries.join("\n")}`,
  );
}

const routedReferences = new Set(
  [...source.matchAll(/\]\((references\/[^\s)#]+\.md)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]),
);
for (const reference of routedReferences) {
  if (posix.dirname(reference) !== "references" || reference.split("/").length !== 2) {
    failures.push(`reference must stay one level below SKILL.md: ${reference}`);
  }
}
for (const reference of requiredReferences) {
  if (!routedReferences.has(reference)) {
    failures.push(`skill is missing reference route: ${reference}`);
  }
}
for (const reference of routedReferences) {
  if (!requiredReferences.includes(reference)) {
    failures.push(`skill routes an unexpected reference: ${reference}`);
  }
}

let packagedSource = source;
for (const entry of actualEntries.filter((value) => !value.endsWith("/"))) {
  const absolute = join(skillRoot, ...entry.split("/"));
  const stats = statSync(absolute);
  const entrySource = readText(absolute);
  if (entry !== "SKILL.md") packagedSource += `\n${entrySource}`;
  if (!entry.endsWith(".md") || entrySource.startsWith("#!") || (stats.mode & 0o111)) {
    failures.push(`skill package contains an unexpected executable file: ${entry}`);
  }
  if (/\b(?:TODO|TBD|FIXME|XXX)\b|Documentation unavailable/i.test(entrySource)) {
    failures.push(`${entry} contains an unfinished marker`);
  }
  if (
    entry.startsWith("references/")
    && entry.endsWith(".md")
    && entrySource.trim().length < 200
  ) {
    failures.push(`${entry} is unexpectedly empty`);
  }
}

for (const required of [
  "AGENTS.md",
  "docs/getting-started.md",
  "docs/integrating-existing-product.md",
  "docs/adding-a-service.md",
  "docs/onboarding.md",
  "provider-full",
]) {
  if (!packagedSource.includes(required)) failures.push(`skill package is missing route: ${required}`);
  if (required.endsWith(".md")) {
    try {
      statSync(required);
    } catch {
      failures.push(`missing ${required}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Daski provider skill validation passed: ${actualEntries.filter((entry) => !entry.endsWith("/")).length} Markdown files\n`,
);
