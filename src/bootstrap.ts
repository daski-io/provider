import { errorExtra, logError } from "./core/logger.js";

try {
  await import("./index.js");
} catch (error) {
  if (error instanceof Error && error.name === "ConfigurationError") {
    logError("Startup configuration is invalid", {
      details: error.message,
      hint: "Run npm run doctor -- --stage=testnet for redacted setup guidance.",
    });
  } else {
    logError("Startup import failed", errorExtra(error));
  }
  process.exitCode = 1;
}
