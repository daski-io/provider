import type { ServiceModule } from "./core/serviceRegistry/types.js";
import { dummyService } from "./services/dummy/index.js";

// The installed-service list is the only composition point for marketplace
// services. Replace the dummy module with your own service modules.
export const providerServices: ServiceModule[] = [dummyService];
