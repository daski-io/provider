import type { ProviderLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { DUMMY_OUTCOME_ID } from "./services/dummy/config.js";

// Provider-owned reviewed policy. Keep this exact allowlist synchronized
// with the signed artifacts issued during Daski provider onboarding.
export const providerLaunchPolicy = {
  outcomeIds: [DUMMY_OUTCOME_ID],
  assetActions: [],
} as const satisfies ProviderLaunchPolicy;
