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

  it("points the skill and guides at the record of the tested gateway revision", () => {
    const record = "test/fixtures/provider-wire.source.json";
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
      repository: "daski-io/gateway",
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const startHere = readFileSync(".agents/skills/daski-provider/references/start-here.md", "utf8")
      .replaceAll("\r\n", "\n").replace(/\s+/g, " ");
    expect(startHere).toContain(`against in \`${record}\``);
    // docs/releasing.md explains the record; it does not name a commit itself.
    expect(startHere).not.toMatch(/`docs\/releasing\.md` names the gateway revision/);
    for (const guide of ["docs/releasing.md", "README.md", "AGENTS.md"]) {
      expect(readFileSync(guide, "utf8"), guide).toContain(record);
    }
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
