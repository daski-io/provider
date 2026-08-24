import { registerServiceProtectedData } from "./core/security/protectedDataSinks.js";
import { runProtectedDataRotationCli } from "./core/security/protectedDataRotationCli.js";
import { providerServices } from "./providerServices.js";
import { registerProviderScreeningProtectedData } from "./providerScreening.js";

// Standalone protected-data rotation entrypoint (`npm run security:rotate`).
// Runs without booting the server, so it must perform the same protected-
// data composition the boot path does: every installed service's sinks and
// encrypted-identifier schemes register before the scan/rotate walks the
// database. Skipping this would fail the completeness check on the first
// service-owned envelope column.
registerProviderScreeningProtectedData();
for (const module of providerServices) {
  registerServiceProtectedData(module);
}

await runProtectedDataRotationCli();
