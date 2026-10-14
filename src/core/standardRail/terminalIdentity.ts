import type { Hex } from "viem";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderTransaction } from "./transactionStore.js";

/** The fields every terminal attestation of one task must carry forever. */
export interface TerminalIdentity {
  state: "completed" | "failed";
  resultHash: Hex;
  completedAt: number;
}

/** Stored terminal data that no longer proves the identity it was frozen with. */
export class TerminalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalIntegrityError";
  }
}

/**
 * The terminal identity a task attests in every dispatch, status and
 * lifecycle answer. Its result hash is the one frozen with the terminal
 * transition; a row that became terminal before hashes were frozen is
 * hashed from its stored result exactly as it was attested then. Nothing
 * here reshapes or re-derives a result.
 */
export function terminalIdentity(row: ProviderTransaction): TerminalIdentity {
  if (
    (row.state !== "completed" && row.state !== "failed")
    || !row.completed_at || !row.result || row.result.status !== row.state
  ) throw new TerminalIntegrityError("Terminal transaction result is incomplete");
  let resultHash: Hex;
  if (row.result_hash === null) {
    resultHash = canonicalHash(row.result);
  } else if (Buffer.isBuffer(row.result_hash) && row.result_hash.length === 32) {
    resultHash = `0x${row.result_hash.toString("hex")}` as Hex;
  } else {
    throw new TerminalIntegrityError("Frozen result hash is malformed");
  }
  return {
    state: row.state,
    resultHash,
    completedAt: Math.floor(row.completed_at.getTime() / 1_000),
  };
}

/**
 * The artifact of a completed task: its stored result, delivered only while
 * its canonical hash still equals the frozen identity, so the bytes a buyer
 * reads always hash to the attested `resultHash`.
 */
export function frozenArtifact(row: ProviderTransaction): ServiceResult {
  const identity = terminalIdentity(row);
  if (identity.state !== "completed") {
    throw new TerminalIntegrityError("Only a completed task has an artifact");
  }
  if (canonicalHash(row.result) !== identity.resultHash) {
    throw new TerminalIntegrityError("Stored result does not match its frozen hash");
  }
  return row.result!;
}
