import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { terminalIdentity } from "./terminalIdentity.js";
import type { ProviderTransaction } from "./transactionStore.js";

export type PublicDispatchState = "submitted" | "working" | "completed" | "failed";

/** Gateway `operations` view. Lite publishes no fulfillment, support or recovery section. */
export interface OperationsObservation {
  schemaVersion: 1;
  revision: number;
  observedAt: number;
  fulfillment: null;
  support: null;
  recovery: null;
}

export interface DispatchSnapshot {
  taskId: string;
  dispatchHash: Hex;
  signature: Hex;
  state: PublicDispatchState;
  operations: OperationsObservation;
  terminalAttestation?: {
    payload: {
      taskId: string;
      dispatchHash: Hex;
      state: "completed" | "failed";
      resultHash: Hex;
      completedAt: number;
    };
    signature: Hex;
  };
}

export interface ProviderResponseSigner {
  authority(digest: Hex): Promise<Hex>;
  terminal(digest: Hex): Promise<Hex>;
}

export function providerResponseSigner(config: ProviderStandardRailConfig): ProviderResponseSigner {
  const authority = privateKeyToAccount(config.providerAuthorityPrivateKey);
  const terminal = privateKeyToAccount(config.terminalAttestationPrivateKey);
  return {
    authority: (digest) => authority.signMessage({ message: { raw: digest } }),
    terminal: (digest) => terminal.signMessage({ message: { raw: digest } }),
  };
}

/** The signer for answers about one order, chosen by its listing version. */
export type ListingSigner = (listingManifestHash: Hex) => ProviderResponseSigner;

/**
 * Answers about an order carry the keys its checkout snapshot named: those of
 * the provider wallet recorded with its listing version. The current wallet
 * signs with the configured authority and terminal keys; an older version's
 * wallet signs both roles with its retained key. A version with no recorded
 * or retained key throws, which callers answer as unavailable, never with a
 * key the gateway would refuse.
 */
export function providerListingSigner(config: ProviderStandardRailConfig): ListingSigner {
  const current = providerResponseSigner(config);
  const retained = new Map<Address, ProviderResponseSigner>();
  for (const [address, key] of config.retainedSigningKeys) {
    const account = privateKeyToAccount(key);
    const sign = (digest: Hex) => account.signMessage({ message: { raw: digest } });
    retained.set(address, { authority: sign, terminal: sign });
  }
  return (listingManifestHash) => {
    const wallet = config.listingWallets.get(listingManifestHash);
    if (wallet === config.terminalAttestationKey) return current;
    const signer = wallet ? retained.get(wallet) : undefined;
    if (!signer) throw new Error("Listing version's signing key is not available");
    return signer;
  };
}

/** The listing version a stored claim was admitted under. */
export const listingOf = (row: Pick<ProviderTransaction, "listing_manifest_hash">): Hex =>
  `0x${row.listing_manifest_hash.toString("hex")}` as Hex;

/**
 * The gateway state of a claim; no new wire state exists. A synchronous
 * `executing` claim is `working`. An external job is `submitted` while
 * queued and `working` while it starts, reconciles or polls, overdue or
 * not. Anything else fails closed rather than being signed.
 */
export function publicDispatchState(
  row: Pick<ProviderTransaction, "state" | "job_phase">,
): PublicDispatchState {
  if (row.state === "executing") return "working";
  if (row.state === "external_job") {
    if (row.job_phase === "queued") return "submitted";
    if (row.job_phase === "starting" || row.job_phase === "reconciling" || row.job_phase === "polling") {
      return "working";
    }
    throw new Error("External job phase is not servable");
  }
  if (row.state === "completed" || row.state === "failed") return row.state;
  throw new Error("Provider transaction state is not servable");
}

/** Whether a public state is terminal (carries a terminal attestation). */
export const isTerminalState = (state: PublicDispatchState): state is "completed" | "failed" =>
  state === "completed" || state === "failed";

/**
 * The persisted projection and its revision, observed at the database clock.
 * Anything but the reviewed all-null projection fails closed rather than
 * being signed.
 */
export function operationsObservation(row: ProviderTransaction): OperationsObservation {
  const projection = row.operations_projection as Record<string, unknown> | null;
  const observedAt = Number(row.observed_at);
  if (
    !projection || typeof projection !== "object" || Array.isArray(projection)
    || Object.keys(projection).sort().join() !== "fulfillment,recovery,support"
    || Object.values(projection).some((section) => section !== null)
    || !Number.isSafeInteger(row.operations_revision) || row.operations_revision < 0
    || !Number.isSafeInteger(observedAt) || observedAt <= 0
  ) throw new Error("Persisted operations projection is not servable");
  return {
    schemaVersion: 1,
    revision: row.operations_revision,
    observedAt,
    fulfillment: null,
    support: null,
    recovery: null,
  };
}

/**
 * Sign the current snapshot of one task for the queried dispatch hash. Every
 * dispatch and status answer re-reads persisted state, stamps the database
 * clock as `observedAt`, and re-signs; a signed body is never cached.
 */
export async function signDispatchSnapshot(
  row: ProviderTransaction,
  dispatchHash: Hex,
  signer: ProviderResponseSigner,
): Promise<DispatchSnapshot> {
  const state = publicDispatchState(row);
  const operations = operationsObservation(row);
  const signature = await signer.authority(canonicalHash({
    taskId: row.id,
    dispatchHash,
    state,
    operations,
  }));
  if (!isTerminalState(state)) return { taskId: row.id, dispatchHash, signature, state, operations };
  const identity = terminalIdentity(row);
  const payload = {
    taskId: row.id,
    dispatchHash,
    state: identity.state,
    resultHash: identity.resultHash,
    completedAt: identity.completedAt,
  };
  return {
    taskId: row.id,
    dispatchHash,
    signature,
    state,
    operations,
    terminalAttestation: { payload, signature: await signer.terminal(canonicalHash(payload)) },
  };
}
