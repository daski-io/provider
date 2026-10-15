import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { expect } from "vitest";
import type { ServiceModule, ServiceResult } from "../src/core/serviceRegistry/types.js";
import { canonicalJson } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderTransaction } from "../src/core/standardRail/transactionStore.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import type { ProviderAnswer } from "./gatewayWire.js";
import { standardOutcome } from "./standardRailOutcomeFixture.js";

/**
 * The vendored daski-io/gateway provider-wire fixtures (see
 * test/fixtures/provider-wire.source.json) and a lite provider configured
 * from their keys and context, as their README prescribes.
 */
export const FIXTURE_DIR = new URL("./fixtures/provider-wire/", import.meta.url);
/** Fixture documents are generated JSON; tests read them structurally. */
type Doc = any;
export const fixture = (name: string): Doc => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));

export const keys = fixture("keys.json").keys as Record<string, { privateKey: Hex; address: Address }>;
export const context = fixture("context.json");
export const LITE = "daski-io/provider";
export const fixedListing = context.listings.fixed;
export const completedResult = context.results.serviceResult.completed as ServiceResult;
export const failedEvidence = context.results.serviceResult.failed as ServiceResult;
export const order = context.order;

export function wireOutcome(): ProviderOutcomeConfig {
  return {
    ...standardOutcome(),
    outcomeId: fixedListing.outcomeId,
    serviceSlug: "notes",
    serviceId: fixedListing.serviceId,
    skillId: fixedListing.skillId,
    listingManifestHash: fixedListing.listingManifestHash,
    providerOfferHash: fixedListing.providerOfferHash,
    fixedGrossAmount: fixedListing.fixedGrossAmount,
    commissionBps: fixedListing.commissionBps,
    token: fixedListing.token,
    splitter: fixedListing.splitter,
    providerPayee: fixedListing.providerPayee,
    daskiCommissionReceiver: fixedListing.daskiCommissionReceiver,
    providerControlProfileHash: context.provider.controlProfileHash,
    activeRailProfileHash: context.gateway.activeRailProfileHash,
    providerTerminalAttestationKey: keys.providerTerminalAttestation!.address,
    dispatchDeadlineSeconds: fixedListing.deadlinePolicy.dispatchSeconds,
    fulfillmentSeconds: fixedListing.deadlinePolicy.fulfillmentSeconds,
    bindingProfile: fixedListing.bindingProfile,
    requestSchema: fixedListing.requestSchema,
    resultSchema: fixedListing.responseSchema,
  };
}

export function wireConfig(): ProviderStandardRailConfig {
  return {
    environment: context.environment,
    chainId: context.chainId,
    gatewayAudience: context.gateway.audience,
    gatewayOrigin: context.gateway.publicUrl,
    providerAudience: context.provider.audience,
    gatewayDispatchSigner: context.gateway.signers["gateway-dispatch"],
    gatewayQuoteSigner: context.gateway.signers["gateway-quote"],
    gatewayLifecycleSigner: context.gateway.signers["gateway-lifecycle"],
    providerAuthorityKey: keys.providerAuthority!.address,
    providerAuthorityPrivateKey: keys.providerAuthority!.privateKey,
    terminalAttestationPrivateKey: keys.providerTerminalAttestation!.privateKey,
    terminalAttestationKey: keys.providerTerminalAttestation!.address,
    evidenceRpcUrls: ["https://rpc.example"],
    outcomes: new Map([[fixedListing.outcomeId, wireOutcome()]]),
    servicing: new Map([[fixedListing.listingManifestHash, wireOutcome()]]),
    unserviceable: new Map(),
    listingWallets: new Map([[fixedListing.listingManifestHash, keys.providerTerminalAttestation!.address]]),
    retainedSigningKeys: new Map(),
    servicingAudiences: new Set([context.provider.audience]),
    providerControlProfileHash: wireOutcome().providerControlProfileHash,
    retainedControlProfileHashes: [],
    globalPolicy: {} as never,
    finalityConfirmations: 12,
    sanctionsOracleAddress: "0x5555555555555555555555555555555555555555",
    reputationContract: context.gateway.reputationContract,
    easAddress: "0x4646464646464646464646464646464646464646",
    easRuntimeCodeHash: `0x${"f".repeat(64)}` as Hex,
    reputationOutcomeSchemaUid: context.gateway.reputationOutcomeSchemaUid,
  };
}

/** The fixture's fixed `create-note` listing as a lite service; `execute` is swappable. */
export function noteService(execute: () => Promise<ServiceResult>): ServiceModule {
  return {
    manifest: {
      slug: "notes",
      version: "1",
      name: "Notes",
      description: "Synthetic fixture notes service",
      categoryFamily: "other",
      serviceType: "other",
      jurisdictions: ["global"],
      turnaroundEstimate: "< 5 seconds",
    },
    skills: [{
      id: fixedListing.skillId,
      name: "Create note",
      description: "Create a synthetic note",
      examples: [],
      fixedPriceAtomic: fixedListing.fixedGrossAmount,
      inputSchema: fixedListing.requestSchema,
      resultSchema: fixedListing.responseSchema,
      deadlines: {
        dispatchSeconds: fixedListing.deadlinePolicy.dispatchSeconds,
        fulfillmentSeconds: fixedListing.deadlinePolicy.fulfillmentSeconds,
      },
    }],
    adapter: { execute },
    readiness: async () => true,
    docs: { service: "Notes", skills: { [fixedListing.skillId]: "Create a note." } },
  };
}

/** The same listing served by an external-job adapter that is never called here. */
export function noteJobService(): ServiceModule {
  const module = noteService(async () => { throw new Error("a synchronous call is never made"); });
  const unreachable = async (): Promise<never> => { throw new Error("no product call is made at admission"); };
  return {
    ...module,
    adapter: { mode: "external-job", version: "v1", start: unreachable, recoverStart: unreachable, poll: unreachable },
  };
}

/** A stored claim for the context order, as the provider's database holds it. */
export function claimRow(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    id: order.providerTaskId,
    gateway_audience: context.gateway.audience,
    order_id: order.orderId,
    dispatch_hash: Buffer.from(fixture("dispatch.json").requests.initial.dispatchHash.slice(2), "hex"),
    payer: order.payer,
    service_slug: "notes",
    skill_id: fixedListing.skillId,
    listing_manifest_hash: Buffer.from(fixedListing.listingManifestHash.slice(2), "hex"),
    state: "executing",
    result: null,
    result_hash: null,
    created_at: new Date(context.times.dispatch * 1_000),
    completed_at: null,
    operations_revision: 0,
    operations_projection: { fulfillment: null, support: null, recovery: null },
    observed_at: "0",
    ...overrides,
  };
}

/**
 * The README's matching rule: the status, `application/json` without a
 * content encoding, and canonical JSON equality of the body.
 */
export function expectWireAnswer(answer: ProviderAnswer, vector: Doc): void {
  expect(answer.status, vector.id).toBe(vector.response.status);
  if (vector.response.bodyText === "") {
    expect(answer.text, vector.id).toBe("");
    return;
  }
  expect(answer.contentType?.split(";", 1)[0], vector.id).toBe("application/json");
  expect(answer.contentEncoding, vector.id).toBeNull();
  expect(canonicalJson(JSON.parse(answer.text)), vector.id).toBe(canonicalJson(vector.response.body));
}

export const appliesToLite = (vector: Doc) => (vector.appliesTo as string[]).includes(LITE);
