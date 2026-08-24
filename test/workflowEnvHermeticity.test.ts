import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEUTRALIZED_ENV_KEYS } from "./setup.js";

// The security-release workflow declares env at the JOB level so its
// image-boot smoke steps share one block — which means every vitest step
// in that job inherits the same variables. test/setup.ts neutralizes them
// (pins or clears) so the suite computes identical config in CI and in any
// developer shell. This guard closes the class: a job-level env key that
// setup.ts does not neutralize fails HERE, in the same CI run that
// introduced it, instead of surfacing later as a CI-only failure of an
// unrelated test (paidQuoteAdmission under leaked CHAIN_MODE=mock —
// PR #18, run 30658417836 — was exactly that).

const WORKFLOW_PATH = fileURLToPath(
  new URL("../.github/workflows/security-release.yml", import.meta.url),
);

// The verify job's env block is the only `env:` at 4-space indentation
// (the postgres service env sits at 8, step-level env blocks at 8+). It
// ends at the next job-level key (`    steps:`). Deliberately a dumb
// line scanner, not a YAML parser: if the workflow layout changes enough
// to break it, this test fails loudly and the hermeticity question gets
// re-asked on purpose.
function jobLevelEnvKeys(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^ {4}env:\s*$/.test(line));
  if (start < 0) {
    throw new Error(
      "job-level env: block not found in security-release.yml — update " +
        "jobLevelEnvKeys() if the workflow layout changed",
    );
  }
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {0,4}\S/.test(line)) break;
    const match = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

describe("security-release job env stays neutralized in vitest runs", () => {
  it("pins or clears every job-level env key in test/setup.ts", () => {
    const keys = jobLevelEnvKeys(readFileSync(WORKFLOW_PATH, "utf8"));
    // Sanity floor so a parser regression cannot pass on an empty scan.
    expect(keys.length).toBeGreaterThanOrEqual(20);
    const leaking = keys.filter((key) => !NEUTRALIZED_ENV_KEYS.has(key));
    expect(
      leaking,
      "these job-level env vars leak into every vitest step of the " +
        "security-release job; pin or clear them in test/setup.ts (see " +
        "the CHAIN_MODE incident note there)",
    ).toEqual([]);
  });
});
