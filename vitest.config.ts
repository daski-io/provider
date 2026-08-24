import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Tests that touch the DB / chain are integration-style and live
    // elsewhere; the in-repo suite is unit-level and runs without a
    // live Postgres.
    //
    // Layout: core + cross-service tests live in test/; tests owned by a
    // single service are co-located under src/services/<slug>/tests/ so
    // a service folder carries its own suite.
    include: [
      "test/**/*.test.ts",
      "src/services/*/tests/**/*.test.ts",
      "src/providerExtensions/*/tests/**/*.test.ts",
    ],
    // Run files serially to avoid races on the shared in-process
    // singletons (taskEvents bus, supplier-credentials cache, etc.).
    // Vitest 4 removed poolOptions.forks.singleFork; one worker running
    // files serially (with default per-file isolation) is the equivalent.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Keep test code out of the coverage denominator — the co-located
      // service suites live inside src/ but are not product code.
      exclude: ["src/services/*/tests/**", "src/providerExtensions/*/tests/**"],
      reporter: ["text-summary", "lcov"],
      // Ratchet floors measured across all production source on 2026-07-29:
      // statements 46.42, branches 41.40, functions 46.66, lines 47.79.
      // The architecture gate prevents these one-point cushions from being
      // lowered to make a build pass.
      thresholds: {
        statements: 45.42,
        branches: 40.4,
        functions: 45.66,
        lines: 46.79,
      },
    },
  },
});
