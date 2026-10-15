import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findUnknownAdapterReferences, readAdapterApi } from "../scripts/skill-rules.mjs";

interface EvaluationCase {
  id: string;
  title: string;
  checkout: "current" | "pre-external-job";
  brief: string;
  expected: {
    selection: string;
    mustState: string[];
    plan: string[];
    adapterOutline?: string[];
    mustNot: string[];
  };
}

const evaluations = JSON.parse(
  readFileSync("test/fixtures/skill-evaluations/cases.json", "utf8"),
) as { schemaVersion: number; skill: string; selections: string[]; cases: EvaluationCase[] };

const EXPECTED: Record<string, string> = {
  "S-T01": "lite-synchronous",
  "S-T02": "lite-external-job",
  "S-T03": "upstream-gap",
  "S-T04": "upstream-gap",
  "S-T05": "provider-full",
  "S-T06": "provider-full",
  "S-T07": "compatible-release-required",
  "S-T08": "lite-external-job",
  "S-T09": "refuse-and-remap",
  "S-T10": "lite-external-job",
  "S-T11": "lite-external-job",
  "S-T12": "package-consistent",
};

// S-T01..S-T12: the synthetic briefs an agent evaluation feeds the packaged
// skill, with the expected selection. The briefs stay synthetic and the
// expected adapter outlines name only the declared API.
describe("provider skill evaluation briefs", () => {
  it("covers S-T01 to S-T12 with their expected selections", () => {
    expect(evaluations).toMatchObject({ schemaVersion: 1, skill: "daski-provider" });
    expect(evaluations.cases.map((item) => item.id)).toEqual(Object.keys(EXPECTED));
    for (const item of evaluations.cases) {
      expect(item.expected.selection, item.id).toBe(EXPECTED[item.id]);
      expect(evaluations.selections).toContain(item.expected.selection);
      expect(item.brief.length, item.id).toBeGreaterThan(80);
      expect(item.brief.length, item.id).toBeLessThan(1_500);
      for (const list of [item.expected.mustState, item.expected.plan, item.expected.mustNot]) {
        expect(list.length, item.id).toBeGreaterThan(0);
      }
    }
    expect(evaluations.cases.find((item) => item.id === "S-T07")?.checkout).toBe("pre-external-job");
  });

  it("uses only synthetic endpoints and declared adapter members", () => {
    const api = readAdapterApi(process.cwd());
    for (const item of evaluations.cases) {
      const text = JSON.stringify(item);
      for (const match of text.matchAll(/https?:\/\/([^/\s"\\]+)/g)) {
        expect(match[1], item.id).toMatch(/(?:^|\.)example$|^github\.com$/);
      }
      expect(findUnknownAdapterReferences((item.expected.adapterOutline ?? []).join("\n"), api), item.id).toEqual([]);
    }
  });

  it("holds S-T12's automated part: one package, matching versions, a concise entrypoint", () => {
    expect(readdirSync(".agents/skills")).toEqual(["daski-provider"]);
    const skill = readFileSync(".agents/skills/daski-provider/SKILL.md", "utf8").replaceAll("\r\n", "\n");
    const version = /^ {2}version: "([^"]+)"$/m.exec(skill)?.[1];
    expect(version).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
    expect(skill.split("\n").length).toBeLessThanOrEqual(180);
    expect(existsSync("src/services/synthetic-audit/upstream.ts")).toBe(true);
    expect(readFileSync("src/services/synthetic-audit/config.ts", "utf8")).toMatch(/https:\/\/[a-z.]+\.example\//);
  });
});
