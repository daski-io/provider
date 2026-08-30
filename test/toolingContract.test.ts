import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("repository tooling contract", () => {
  it("validates the checked-in portable skill", () => {
    const result = spawnSync(process.execPath, ["scripts/validate-skill.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skill validation passed");
  });

  it("normalizes CRLF before reading skill frontmatter", () => {
    const validator = readFileSync("scripts/validate-skill.mjs", "utf8");
    expect(validator).toContain('.replaceAll("\\r\\n", "\\n")');
    expect(validator).toContain('.replaceAll("\\r", "\\n")');
  });

  it("uses the sanitized bootstrap in every runtime entrypoint", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(packageJson.scripts.dev).toContain("src/bootstrap.ts");
    expect(packageJson.scripts.start).toContain("dist/bootstrap.js");
    expect(packageJson.scripts["daski:install-runtime"]).toContain(
      "src/installRuntimeBundle.ts",
    );
    expect(dockerfile).toContain('CMD ["node", "dist/bootstrap.js"]');
  });
});
