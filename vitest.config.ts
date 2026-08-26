import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Tests that touch a real DB or chain are separate integration gates; the
    // in-repo suite is unit-level and works offline.
    include: [
      "test/**/*.test.ts",
      "src/services/*/tests/**/*.test.ts",
    ],
    // Shared rail/database module mocks are deterministic when files run
    // serially. Vitest still isolates individual files.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/services/*/tests/**"],
      reporter: ["text-summary", "lcov"],
      // One-point cushions under the measured 2026-08-26 slim baseline:
      // statements 51.38, branches 52.90, functions 55.14, lines 52.70.
      thresholds: {
        statements: 50.3,
        branches: 51.9,
        functions: 54.1,
        lines: 51.7,
      },
    },
  },
});
