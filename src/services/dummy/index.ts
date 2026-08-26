import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceModule } from "../../core/serviceRegistry/types.js";
import { DummyAdapter } from "./adapter.js";
import { skills, manifest } from "./manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = (name: string) => readFileSync(join(here, "docs", `${name}.md`), "utf8");

export const dummyService: ServiceModule = {
  manifest,
  skills,
  adapter: new DummyAdapter(),
  readiness: async () => true,
  docs: {
    service: doc("index"),
    skills: { echo: doc("echo") },
  },
};
