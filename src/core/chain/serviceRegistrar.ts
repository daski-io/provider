import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";
import {
  publicClient,
  CHAIN_MODE_MOCK,
} from "./client.js";
import { serviceRegistryAbi } from "./abis.js";
import { config } from "../config.js";
import {
  listActiveServices,
  setServiceOnChainId,
  type ServiceRow,
} from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import {
  confirmProviderWrite,
  prepareAndBroadcastProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import {
  finalizedReadBlockNumber,
  waitForCanonicalFinalReceipt,
} from "./finality.js";
import { redactSensitiveText } from "../security/redaction.js";
import { logWarn } from "../logger.js";

function safeRegistrationError(error: unknown): string {
  return redactSensitiveText((error as Error).message)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512) || "service registration verification failed";
}

// ServiceRegistry bootstrap. Every service has an on-chain catalog identity
// independent of the standard payment rail.
//
// This module runs once at app boot, after the service registry has
// seeded `services` from each ServiceModule's manifest. For each active
// service row without an on_chain_id we:
//   1. Derive the expected serviceId (pure helper on the contract).
//   2. Check whether it already exists on-chain (idempotent reboot).
//   3. If not, submit registerService(...) from the provider wallet.
//   4. Write the resulting bytes32 back to services.on_chain_id.
//   5. Emit a chain.service_registered event for the platform log.
//
// Re-registration on `version` bump is handled by inserting a new
// services row with the new version (the registry seeder respects the
// (slug, version) UNIQUE constraint); the next bootstrap picks it up.

interface BootstrapResult {
  registered: number;
  already_on_chain: number;
  skipped_missing_data: number;
}

export interface ServiceRegistrationHealth {
  ok: boolean;
  checkedAt: Date | null;
  error: string | null;
}

let registrationHealth: ServiceRegistrationHealth = {
  ok: false,
  checkedAt: null,
  error: "service registration has not been reconciled",
};
const SERVICE_VERIFICATION_MAX_AGE_MS =
  config.REGISTRATION_RECONCILE_MAX_AGE_SECONDS * 1_000;
const verifiedServices = new Map<string, {
  onChainId: string;
  serviceWallet: string;
  checkedAt: Date;
  ok: boolean;
  error: string | null;
}>();
const INHERITED_SERVICE_WALLET = "0x0000000000000000000000000000000000000000";

function expectedServiceWallet(service: ServiceRow): string {
  return (service.service_wallet ?? INHERITED_SERVICE_WALLET).toLowerCase();
}
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationInFlight: Promise<BootstrapResult> | null = null;

export function getServiceRegistrationHealth(): ServiceRegistrationHealth {
  return { ...registrationHealth };
}

export function getServiceRegistrationAuthorization(service: ServiceRow): {
  ok: boolean;
  reason: string | null;
} {
  if (!service.on_chain_id) return { ok: false, reason: "service has no on-chain registration" };
  const verification = verifiedServices.get(service.id);
  if (!verification?.ok) {
    return { ok: false, reason: verification?.error ?? "service registration is not verified" };
  }
  if (Date.now() - verification.checkedAt.getTime() > SERVICE_VERIFICATION_MAX_AGE_MS) {
    return { ok: false, reason: "service registration verification is stale" };
  }
  const localId = `0x${service.on_chain_id.toString("hex")}`.toLowerCase();
  if (verification.onChainId !== localId) {
    return { ok: false, reason: "service registration changed after verification" };
  }
  if (verification.serviceWallet !== expectedServiceWallet(service)) {
    return { ok: false, reason: "service payout destination changed after verification" };
  }
  return { ok: true, reason: null };
}

export async function bootstrapServiceRegistry(): Promise<BootstrapResult> {
  const services = await listActiveServices();
  const result: BootstrapResult = {
    registered: 0,
    already_on_chain: 0,
    skipped_missing_data: 0,
  };

  if (CHAIN_MODE_MOCK) {
    for (const service of services) {
      const mockId = mockServiceId(service);
      if (!service.on_chain_id || !service.on_chain_id.equals(hexToBuffer(mockId))) {
        await setServiceOnChainId(service.id, hexToBuffer(mockId));
      }
      verifiedServices.set(service.id, {
        onChainId: mockId.toLowerCase(),
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: true, error: null,
      });
      result.already_on_chain++;
    }
    registrationHealth = { ok: true, checkedAt: new Date(), error: null };
    return result;
  }

  for (const service of services) {
    const before = service.on_chain_id;
    let onChainId: Hex;
    try {
      onChainId = await registerOne(service);
      verifiedServices.set(service.id, {
        onChainId: onChainId.toLowerCase(),
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: true, error: null,
      });
    } catch (error) {
      verifiedServices.set(service.id, {
        onChainId: before ? `0x${before.toString("hex")}`.toLowerCase() : "",
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: false, error: safeRegistrationError(error),
      });
      throw error;
    }
    if (!before || !before.equals(hexToBuffer(onChainId))) {
      await setServiceOnChainId(service.id, hexToBuffer(onChainId));
      result.registered++;
    } else {
      result.already_on_chain++;
    }
    await emitEvent({
      serviceId: service.id,
      source: "chain",
      type: "chain.service_registration_verified",
      message: `Verified ${service.slug} v${service.version} on ServiceRegistry`,
      payload: {
        slug: service.slug,
        version: service.version,
        onChainId,
        serviceURI: serviceUriFor(service),
      },
    });
  }

  registrationHealth = { ok: true, checkedAt: new Date(), error: null };
  return result;
}

function serviceUriFor(service: ServiceRow): string {
  return new URL(`/agent-cards/${service.slug}.json`, config.BASE_URL).toString();
}

function mockServiceId(service: ServiceRow): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, string, string"), [
      config.PROVIDER_AGENT_ID,
      service.slug,
      service.version,
    ]),
  );
}

async function registerOne(service: ServiceRow): Promise<Hex> {
  // 1. Compute the expected serviceId without any state change.
  const expected = (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "computeServiceId",
    args: [config.PROVIDER_AGENT_ID, service.slug, service.version],
  })) as Hex;

  // 2. Did someone else already register this id (e.g. a prior boot
  // that succeeded on-chain but failed before writing services.on_chain_id)?
  // The contract reverts on collision so we must check first.
  const finalizedBlock = await finalizedReadBlockNumber();
  const exists = (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "exists",
    args: [expected],
    blockNumber: finalizedBlock,
  })) as boolean;

  if (exists) {
    await reconcileRegisteredService(service, expected, finalizedBlock);
    return expected;
  }

  // 3. Submit a registration tx. serviceWallet=0x0 inherits the provider
  // wallet; a non-zero wallet records a service-specific operating account.
  const serviceWallet = (service.service_wallet ??
    INHERITED_SERVICE_WALLET) as Hex;

  let peerRegistrationBlock: bigint | null = null;
  let write;
  try {
    write = await prepareAndBroadcastProviderWrite({
      purpose: "service_registration",
      target: { type: "service", id: service.id },
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "registerService",
      callArgs: [
        config.PROVIDER_AGENT_ID,
        service.slug,
        service.version,
        serviceUriFor(service),
        serviceWallet,
      ],
      preflight: async () => {
        const blockNumber = await finalizedReadBlockNumber();
        const nowExists = await publicClient.readContract({
          address: config.SERVICE_REGISTRY_ADDRESS as Hex,
          abi: serviceRegistryAbi,
          functionName: "exists",
          args: [expected],
          blockNumber,
        }) as boolean;
        if (nowExists) {
          peerRegistrationBlock = blockNumber;
          throw new PeerRegistrationObserved();
        }
      },
      persist: async () => true,
    });
  } catch (error) {
    if (!(error instanceof PeerRegistrationObserved) || peerRegistrationBlock === null) {
      throw error;
    }
    await reconcileRegisteredService(service, expected, peerRegistrationBlock);
    return expected;
  }
  const receipt = await waitForCanonicalFinalReceipt(write.hash);
  if (receipt.status !== "success") {
    await revertProviderWrite(write.id, "canonical_receipt_reverted");
    throw new Error(`registerService tx reverted: ${write.hash}`);
  }
  await confirmProviderWrite(write.id);
  const postRegistrationBlock = await finalizedReadBlockNumber();
  await assertRegisteredService(service, expected, postRegistrationBlock);
  return expected;
}

class PeerRegistrationObserved extends Error {
  constructor() {
    super("Service was registered by another provider replica");
    this.name = "PeerRegistrationObserved";
  }
}

interface RegisteredService {
  providerAgentId: bigint;
  serviceId: Hex;
  serviceSlug: string;
  version: string;
  serviceURI: string;
  serviceWallet: Hex;
  active: boolean;
}

async function readRegisteredService(
  expected: Hex,
  blockNumber: bigint,
): Promise<RegisteredService> {
  return (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "getService",
    args: [expected],
    blockNumber,
  })) as RegisteredService;
}

/** Identity and payout fields — everything except the mutable discovery URI. */
function registeredIdentityMatches(
  service: ServiceRow,
  expected: Hex,
  registered: RegisteredService,
): boolean {
  return registered.providerAgentId === config.PROVIDER_AGENT_ID
    && registered.serviceId.toLowerCase() === expected.toLowerCase()
    && registered.serviceSlug === service.slug
    && registered.version === service.version
    && registered.serviceWallet.toLowerCase() === expectedServiceWallet(service)
    && registered.active;
}

// An existing on-chain entry must match the local identity exactly. One
// field is operator-mutable and self-heals here: serviceURI. The discovery
// pointer legitimately changes when the AgentCard layout evolves (it moved
// from per-domain /.well-known/agent-card.json to /agent-cards/<slug>.json
// in 2026-07), and the registry contract exposes updateServiceURI for
// exactly that. Identity and payout fields (agent id, slug, version,
// serviceWallet, active) never self-heal — drift there stays fail-closed
// because rewriting them from local state could launder a hijacked entry.
async function reconcileRegisteredService(
  service: ServiceRow,
  expected: Hex,
  blockNumber: bigint,
): Promise<void> {
  const registered = await readRegisteredService(expected, blockNumber);
  const canonicalUri = serviceUriFor(service);
  if (
    registeredIdentityMatches(service, expected, registered)
    && registered.serviceURI !== canonicalUri
  ) {
    const write = await prepareAndBroadcastProviderWrite({
      purpose: "service_uri_update",
      target: { type: "service", id: service.id },
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "updateServiceURI",
      callArgs: [expected, canonicalUri],
      persist: async () => true,
    });
    const receipt = await waitForCanonicalFinalReceipt(write.hash);
    if (receipt.status !== "success") {
      await revertProviderWrite(write.id, "canonical_receipt_reverted");
      throw new Error(`updateServiceURI tx reverted: ${write.hash}`);
    }
    await confirmProviderWrite(write.id);
    await emitEvent({
      serviceId: service.id,
      source: "chain",
      type: "chain.service_uri_updated",
      message: `Updated stale ServiceRegistry URI for ${service.slug} v${service.version}`,
      payload: {
        slug: service.slug,
        version: service.version,
        onChainId: expected,
        serviceURI: canonicalUri,
      },
    });
    const healedBlock = await finalizedReadBlockNumber();
    await assertRegisteredService(service, expected, healedBlock);
    return;
  }
  if (
    !registeredIdentityMatches(service, expected, registered)
    || registered.serviceURI !== canonicalUri
  ) {
    throw new Error(`ServiceRegistry entry for ${service.slug} does not match local identity`);
  }
}

async function assertRegisteredService(
  service: ServiceRow,
  expected: Hex,
  blockNumber: bigint,
): Promise<void> {
  const registered = await readRegisteredService(expected, blockNumber);
  if (
    !registeredIdentityMatches(service, expected, registered)
    || registered.serviceURI !== serviceUriFor(service)
  ) {
    throw new Error(`ServiceRegistry entry for ${service.slug} does not match local identity`);
  }
}

// Deadline for one reconcile cycle. Kept under the reconciler's 60s interval
// so a hung cycle frees the in-flight slot before the next tick fires: the
// chain reads, receipt waits, and the signer lease inside a cycle have no
// overall bound of their own, and one hung cycle would otherwise freeze
// reconciliationInFlight forever — readiness (and, via verification
// staleness, every paid purchase) then fails closed with no recovery path
// until a restart. Observed live on v0.6.2, 2026-07-16.
const RECONCILE_DEADLINE_MS = 45_000;
let reconcileAttempt = 0;

export function reconcileServiceRegistrations(): Promise<BootstrapResult> {
  if (reconciliationInFlight) return reconciliationInFlight;
  const attempt = ++reconcileAttempt;
  const work = bootstrapServiceRegistry();
  let deadlineTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      reject(new Error(
        `service registration reconcile exceeded ${RECONCILE_DEADLINE_MS}ms; `
        + "a chain read/write or the signer lease is not completing",
      ));
    }, RECONCILE_DEADLINE_MS);
    deadlineTimer.unref();
  });
  // A timed-out cycle keeps running detached. Absorb its eventual outcome so
  // it can neither become an unhandled rejection nor go unnoticed.
  void work.then(
    () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timedOut) {
        logWarn("Timed-out service registration reconcile eventually completed", {});
      }
    },
    (error) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timedOut) {
        logWarn("Timed-out service registration reconcile eventually failed", {
          error: safeRegistrationError(error),
        });
      }
    },
  );
  reconciliationInFlight = Promise.race([work, deadline])
    .catch((error) => {
      // The attempt guard keeps a superseded cycle from overwriting a newer
      // cycle's verdict or clearing a newer cycle's in-flight slot.
      if (attempt === reconcileAttempt) {
        registrationHealth = {
          ok: false,
          checkedAt: new Date(),
          error: safeRegistrationError(error),
        };
      }
      logWarn("Service registration reconcile failed", {
        error: safeRegistrationError(error),
      });
      throw error;
    })
    .finally(() => {
      if (attempt === reconcileAttempt) reconciliationInFlight = null;
    });
  return reconciliationInFlight;
}

export function startServiceRegistrationReconciler(intervalMs = 60_000): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    void reconcileServiceRegistrations().catch(() => {
      // Already logged and recorded in registrationHealth by the reconcile
      // itself; swallowed here only so the fire-and-forget tick cannot raise
      // an unhandled rejection.
    });
  }, intervalMs);
}

export function stopServiceRegistrationReconciler(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

function hexToBuffer(hex: Hex): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}
