import { defineConfig } from "vitest/config";

const criticalFiles = [
  "src/core/chain/runtimeTrust.ts",
  "src/core/db/sessionAdvisoryLock.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/standardRail/paymentBinding.ts",
  "src/core/suppliers/operationJournal.ts",
];

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    include: [
      "test/runtimeChainTrust.test.ts",
      "test/sessionAdvisoryLock.test.ts",
      "test/reviewedEndpoint.test.ts",
      "test/paymentBinding.test.ts",
      "test/supplierOperationJournal.test.ts",
    ],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: criticalFiles,
      reporter: ["text"],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90
      }
    }
  }
});
