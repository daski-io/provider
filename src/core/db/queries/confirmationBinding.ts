import { createHash } from "node:crypto";
import { canonicalActionArguments } from "./confirmationCanonical.js";

export interface ConfirmationBinding {
  operatorWallet: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  actionName: string;
  /** Stable identifying arguments are hashed into the binding. Model-authored
   * free text belongs in the encrypted stored payload. */
  arguments: Record<string, unknown>;
  targetType: string;
  targetId: string;
}

export function confirmationArgumentsDigest(argumentsValue: Record<string, unknown>): Buffer {
  return createHash("sha256")
    .update(canonicalActionArguments(argumentsValue), "utf8")
    .digest();
}

export function validateConfirmationBinding(binding: ConfirmationBinding): void {
  if (!binding.operatorWallet || !binding.sessionId || !binding.threadId || !binding.turnId) {
    throw new Error("confirmation intent requires operator, session, thread, and turn bindings");
  }
  if (binding.actionName.length < 1 || binding.actionName.length > 128) {
    throw new Error("confirmation action name must be 1-128 characters");
  }
  if (binding.targetType.length < 1 || binding.targetType.length > 64) {
    throw new Error("confirmation target type must be 1-64 characters");
  }
  if (binding.targetId.length < 1 || binding.targetId.length > 256) {
    throw new Error("confirmation target id must be 1-256 characters");
  }
}
