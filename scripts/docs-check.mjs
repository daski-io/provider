import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const markdown = [];

function walk(path) {
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === ".git") continue;
    const absolute = join(path, name);
    if (statSync(absolute).isDirectory()) walk(absolute);
    else if (name.endsWith(".md")) markdown.push(absolute);
  }
}

for (const required of [
  "README.md", "AGENTS.md", "SECURITY.md", "docs/getting-started.md",
  "docs/integrating-existing-product.md", "docs/adding-a-service.md",
  "docs/configuration.md", "docs/onboarding.md", "docs/troubleshooting.md",
  "docs/architecture.md", "docs/protocol-cheatsheet.md", "docs/agent-skill.md",
  ".agents/skills/daski-provider/SKILL.md",
]) {
  if (!existsSync(join(root, required))) failures.push(`missing ${required}`);
}

walk(root);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const file of markdown) {
  const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURI(target)))) {
      failures.push(`${relative(root, file)}: broken link ${match[1]}`);
    }
  }
  for (const match of source.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    if (!packageJson.scripts[match[1]]) {
      failures.push(`${relative(root, file)}: unknown npm script ${match[1]}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`documentation check passed: ${markdown.length} Markdown files\n`);
