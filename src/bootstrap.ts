import { errorExtra, logError } from "./core/logger.js";

try {
  await import("./index.js");
} catch (error) {
  if (error instanceof Error && error.name === "ConfigurationError") {
    logError("Startup configuration is invalid", {
      details: error.message,
    });
  } else {
    logError("Startup import failed", errorExtra(error));
  }
  process.exitCode = 1;
}
