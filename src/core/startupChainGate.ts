import {
  setProviderIdentityVerified,
} from "./health.js";
import { verifyProviderIdentity } from "./chain/providerIdentity.js";
import {
  getServiceRegistrationHealth,
  reconcileServiceRegistrations,
} from "./chain/serviceRegistrar.js";
import { verifyRuntimeChainTrust } from "./chain/runtimeTrust.js";

interface StartupChainGateDependencies {
  verifyChainTrust(): Promise<void>;
  verifyIdentity(): Promise<boolean>;
  markIdentityVerified(verified: boolean): void;
  reconcileRegistrations(): Promise<{
    registered: number;
    already_on_chain: number;
    skipped_missing_data: number;
  }>;
  registrationHealth(): {
    ok: boolean;
    checkedAt: Date | null;
    error: string | null;
  };
}

const defaults: StartupChainGateDependencies = {
  verifyChainTrust: verifyRuntimeChainTrust,
  verifyIdentity: verifyProviderIdentity,
  markIdentityVerified: setProviderIdentityVerified,
  reconcileRegistrations: reconcileServiceRegistrations,
  registrationHealth: getServiceRegistrationHealth,
};

export async function enforceInitialChainReadiness(
  dependencies: StartupChainGateDependencies = defaults,
): Promise<{
  reconciliation: {
    registered: number;
    already_on_chain: number;
    skipped_missing_data: number;
  };
  checkedAt: Date;
}> {
  await dependencies.verifyChainTrust();

  const providerVerified = await dependencies.verifyIdentity();
  if (!providerVerified) {
    throw new Error("Provider wallet does not match the registered agent wallet");
  }
  dependencies.markIdentityVerified(true);

  const reconciliation = await dependencies.reconcileRegistrations();
  const registration = dependencies.registrationHealth();
  if (!registration.ok || !registration.checkedAt) {
    throw new Error(
      registration.error ?? "Service registration reconciliation failed",
    );
  }
  return { reconciliation, checkedAt: registration.checkedAt };
}
