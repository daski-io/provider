import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("accepts a 180-line entrypoint and refuses a 181-line one, however its lines end", () => {
    // A copy of what the validator reads, with the entrypoint padded to size.
    const root = mkdtempSync(join(tmpdir(), "daski-skill-cap-"));
    try {
      for (const path of [".agents", "package.json", "AGENTS.md", "docs", "src/core/serviceRegistry", "src/core/security"]) {
        cpSync(path, join(root, path), { recursive: true });
      }
      const skill = join(root, ".agents/skills/daski-provider/SKILL.md");
      const lines = readFileSync(skill, "utf8").replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
      const validate = (count: number, eol: string, final: boolean) => {
        const padded = [...lines, ...Array.from({ length: count - lines.length }, (_, index) => `Filler ${index}.`)];
        writeFileSync(skill, padded.join(eol) + (final ? eol : ""));
        return spawnSync(process.execPath, [resolve("scripts/validate-skill.mjs")], { cwd: root, encoding: "utf8" });
      };
      for (const [eol, final] of [["\n", true], ["\n", false], ["\r\n", true]] as const) {
        const atCap = validate(180, eol, final);
        expect(atCap.status, atCap.stderr).toBe(0);
        const over = validate(181, eol, final);
        expect(over.status).toBe(1);
        expect(over.stderr).toContain("SKILL.md should remain a concise router of at most 180 lines");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
