import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { terminalIdentity } from "./terminalIdentity.js";
import type { ProviderTransaction } from "./transactionStore.js";

export type PublicDispatchState = "working" | "completed" | "failed";

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

/** Legacy synchronous `executing` is the gateway's `working`; no new wire state exists. */
export function publicDispatchState(state: ProviderTransaction["state"]): PublicDispatchState {
  if (state === "executing") return "working";
  if (state === "completed" || state === "failed") return state;
  throw new Error("Provider transaction state is not servable");
}

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
  const state = publicDispatchState(row.state);
  const operations = operationsObservation(row);
  const signature = await signer.authority(canonicalHash({
    taskId: row.id,
    dispatchHash,
    state,
    operations,
  }));
  if (state === "working") return { taskId: row.id, dispatchHash, signature, state, operations };
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
