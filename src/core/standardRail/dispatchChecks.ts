import type { ValidateFunction } from "ajv";
import { pool } from "../db/pool.js";
import {
  externalJobAdmissionBlocker,
  planExternalJob,
  type ExternalJobAdmission,
} from "../externalJobs/admission.js";
import type { ExternalJobRuntime } from "../externalJobs/runtime.js";
import { logWarn } from "../logger.js";
import { getAdmittingAdapter, getSkill } from "../serviceRegistry/registry.js";
import type { ExternalJobAdapter } from "../serviceRegistry/types.js";
import { assertExactKeys } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { DispatchRejectedError, withDispatchRejection } from "./dispatchErrors.js";
import {
  assertDispatchIsCurrent,
  assertDispatchPayloadBound,
  assertOutcomeBinding,
} from "./dispatchVerification.js";
import type { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { assertProviderQuoteBinding, verifyQuoteEnvelope } from "./quoteBinding.js";
import { loadProviderQuote } from "./quoteStore.js";
import type { ResultContracts } from "./resultContracts.js";
import { validateProviderRequest } from "./schema.js";
import type { ResultContract } from "./serviceResult.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

export interface DispatchRequest {
  dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  evidenceBundle: StandardEvidenceBundleV2;
}

/** How a new claim executes, decided before it is admitted. */
export type AdmissionPlan =
  | { kind: "sync"; contract: ResultContract }
  | { kind: "external-job"; job: ExternalJobAdmission };

/** What the pre-admission checks read: configuration, evidence, readiness and contracts. */
export interface DispatchChecks {
  config: ProviderStandardRailConfig;
  chainId: number;
  evidence: Pick<ProviderEvidenceVerifier, "verify" | "assertNotSanctioned">;
  ready: () => Promise<boolean>;
  externalJobs: ExternalJobRuntime;
  validators: ReadonlyMap<string, ValidateFunction>;
  resultContracts: ResultContracts;
}

export function parseDispatchRequest(body: unknown): DispatchRequest {
  try {
    assertExactKeys(body, ["dispatch", "quote", "request", "evidenceBundle"], "dispatch request");
  } catch {
    throw new DispatchRejectedError("validator", false);
  }
  const parts = body as Record<string, unknown>;
  for (const key of ["dispatch", "quote", "request", "evidenceBundle"]) {
    const value = parts[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DispatchRejectedError("validator", false);
    }
  }
  return parts as unknown as DispatchRequest;
}

/** The admitted result schema and reviewed failure codes, resolved before admission. */
function resultContract(checks: DispatchChecks, outcome: ProviderOutcomeConfig): ResultContract {
  const contract = checks.resultContracts.forListing(outcome.listingManifestHash, outcome.serviceSlug);
  if (!contract) throw new DispatchRejectedError("outcome_policy");
  return contract;
}

/**
 * An external job is admitted only while async admission is on and a key
 * can seal its input; product readiness is not consulted (the worker
 * waits for the product), and its stable idempotency key is fixed here.
 */
async function externalJobPlan(
  checks: DispatchChecks,
  adapter: ExternalJobAdapter,
  outcome: ProviderOutcomeConfig,
  dispatch: StandardRailDispatchV2,
  input: Record<string, unknown>,
): Promise<AdmissionPlan> {
  const blocker = await withDispatchRejection(
    "service_unavailable",
    () => externalJobAdmissionBlocker(checks.externalJobs, pool),
  );
  if (blocker) {
    logWarn("External-job dispatch refused before admission", { diagnostic: blocker });
    throw new DispatchRejectedError("service_unavailable");
  }
  const job = planExternalJob({
    adapter,
    identity: {
      environment: checks.config.environment,
      chainId: checks.chainId,
      providerAgentId: checks.externalJobs.providerAgentId,
      gatewayAudience: dispatch.gatewayAudience,
      orderId: dispatch.orderId,
      serviceSlug: outcome.serviceSlug,
      skillId: outcome.skillId,
    },
    fulfillmentSeconds: outcome.fulfillmentSeconds,
    input,
  });
  if (!job) throw new DispatchRejectedError("validator");
  return { kind: "external-job", job };
}

/** Every check before admission; any failure here is a definite refusal. */
export async function verifyNewDispatch(
  checks: DispatchChecks,
  parts: DispatchRequest,
): Promise<{ outcome: ProviderOutcomeConfig; plan: AdmissionPlan }> {
  const { config, chainId } = checks;
  const dispatch = parts.dispatch.payload;
  try {
    assertDispatchPayloadBound(parts.dispatch, parts.request, config, chainId);
    // The funded order's own listing version, even if a newer one now takes
    // new sales: it is served with the definition it was paid under.
    const outcome = config.servicing.get(dispatch.listingManifestHash);
    if (!outcome || outcome.providerOfferHash !== dispatch.providerOfferHash) {
      throw new DispatchRejectedError("outcome_policy");
    }
    assertDispatchIsCurrent(parts.dispatch, outcome);
    assertOutcomeBinding(dispatch, outcome, config);
    await verifyQuoteEnvelope(parts.quote, dispatch, outcome, config, chainId);
    const providerQuote = await withDispatchRejection(
      "service_unavailable",
      () => loadProviderQuote(parts.quote.payload.providerQuoteHash),
    );
    assertProviderQuoteBinding(providerQuote, parts.quote, dispatch, outcome);
    const validate = checks.validators.get(outcome.listingManifestHash);
    if (!validate) throw new DispatchRejectedError("validator");
    await withDispatchRejection("validator", () => validateProviderRequest(validate, parts.request));
    // The handler must be installed. The price is the version's admitted
    // one, which the provider quote binding has already enforced, even when
    // the build now sells at another price (contract drift). The adapter
    // version that sold the quote runs the order, even when new sales have
    // moved to another version or mode; a build without it cannot admit it.
    const adapter = getAdmittingAdapter(outcome.serviceSlug, providerQuote.adapterVersion);
    if (!adapter || !getSkill(outcome.serviceSlug, outcome.skillId)) {
      throw new DispatchRejectedError("outcome_policy");
    }
    const contract = resultContract(checks, outcome);
    let plan: AdmissionPlan;
    if (adapter.mode === "external-job") {
      plan = await externalJobPlan(checks, adapter, outcome, dispatch, parts.request);
    } else {
      // Synchronous execution during an outage would sign a terminal
      // failure; refusing before admission lets the gateway retry.
      if (!(await checks.ready().catch(() => false))) {
        throw new DispatchRejectedError("service_unavailable");
      }
      plan = { kind: "sync", contract };
    }
    const verified = await withDispatchRejection("evidence", () => checks.evidence.verify({
      dispatch,
      quote: parts.quote,
      outcome,
      bundle: parts.evidenceBundle,
    }));
    for (const participant of [
      dispatch.payer, config.providerAuthorityKey, config.terminalAttestationKey,
      outcome.providerPayee, outcome.daskiCommissionReceiver, ...outcome.providerControlledWallets,
    ]) await withDispatchRejection("evidence", () => checks.evidence.assertNotSanctioned(participant));
    await withDispatchRejection("evidence", () => admitStandardEvidence(
      dispatch.orderId,
      parts.evidenceBundle,
      verified.authorizationKey,
    ));
    return { outcome, plan };
  } catch (error) {
    if (error instanceof DispatchRejectedError) throw error;
    throw new DispatchRejectedError("validator");
  }
}
