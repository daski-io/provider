import {
  checkEnvironment,
  checkNode,
  checkRepository,
  checkRuntimeConfiguration,
  checkServiceComposition,
  checkStageBindings,
} from "./environment.mjs";
import {
  checkDatabase,
  checkLiveProbes,
  checkSignedArtifacts,
} from "./dependencies.mjs";
import { result } from "./common.mjs";

export async function runDiagnostics({ stage, live }) {
  const checks = [];
  checks.push(checkNode());
  checks.push(await checkRepository());
  checks.push(await checkEnvironment(stage));
  checks.push(await checkDatabase());
  checks.push(await checkServiceComposition(stage));
  checks.push(checkStageBindings(stage));
  const runtime = await checkRuntimeConfiguration(stage);
  checks.push(runtime);
  checks.push(await checkSignedArtifacts(stage, runtime.status === "pass"));
  if (stage === "mainnet") {
    checks.push(result(
      "MAINNET_WHITELIST_REQUIRED",
      "warn",
      "Daski Mainnet whitelisting is a manual external gate",
      "Request and retain approval through the Daski Discord. No local flag " +
        "or artifact can self-grant admission.",
    ));
  }
  if (live) checks.push(await checkLiveProbes(stage));
  return checks;
}
