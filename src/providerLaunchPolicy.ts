import type { ProviderOutcomeLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { DUMMY_OUTCOME_ID } from "./services/dummy/config.js";

// Keep this exact set synchronized with Daski-issued onboarding artifacts.
export const providerLaunchPolicy = {
  outcomeIds: [DUMMY_OUTCOME_ID],
} as const satisfies ProviderOutcomeLaunchPolicy;
