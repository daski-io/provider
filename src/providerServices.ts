import type { ServiceModule } from "./core/serviceRegistry/types.js";
import { assertDummyServiceAllowed } from "./services/dummy/config.js";
import { dummyService } from "./services/dummy/index.js";

// This is the only service composition point. Replace dummyService with your
// own synchronous ServiceModule before onboarding.
export function configuredServices(chainId: number): ServiceModule[] {
  assertDummyServiceAllowed(chainId);
  return [dummyService];
}
