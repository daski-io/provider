import { config } from "./core/config.js";
import type { ServiceModule } from "./core/serviceRegistry/types.js";
import { assertDummyServiceAllowed } from "./services/dummy/config.js";
import { dummyService } from "./services/dummy/index.js";

// The starter service is installed for local development and Base Sepolia.
// A production provider must replace it with a real service.
assertDummyServiceAllowed(config.CHAIN_ID);

// The installed-service list is the only composition point for marketplace
// services. Replace the dummy module with your own service modules.
export const providerServices: ServiceModule[] = [dummyService];
