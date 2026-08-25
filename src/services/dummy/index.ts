import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ServiceModule } from "../../core/serviceRegistry/types.js";
import { manifest, skills } from "./manifest.js";
import { DummyAdapter } from "./adapter.js";
import { preExecuteAgent } from "./preExecuteAgent.js";

// Compiled and tested reference implementation of ServiceModule.
// docs/adding-a-service.md walks through copying this folder.
const HERE = dirname(fileURLToPath(import.meta.url));

function tryDoc(name: string, fallback: string): string {
  try {
    return readFileSync(join(HERE, "docs", `${name}.md`), "utf8");
  } catch {
    return fallback;
  }
}

const fallback = (id: string) => `# ${id}\n\nDocumentation unavailable.\n`;

export const dummyService: ServiceModule = {
  manifest,
  skills,
  fulfillment: {
    adapter: new DummyAdapter(),
    preExecuteAgent,
  },
  protocol: {
    docs: {
      service: tryDoc("index", "# Dummy Notes\n\nDocumentation unavailable.\n"),
      skills: Object.fromEntries(
        skills.map((skill) => [skill.id, tryDoc(skill.id, fallback(skill.id))]),
      ),
    },
  },
};
