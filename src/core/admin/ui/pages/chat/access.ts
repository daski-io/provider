import type { ChatThreadRow } from "../../../../db/queries/chatThreads.js";

/**
 * Escalation threads are shared operator work. Free-form threads contain one
 * operator's private conversation and are restricted to their SIWE wallet.
 */
export function canAccessChatThread(
  thread: ChatThreadRow,
  walletAddress: string,
): boolean {
  return (
    thread.escalation_id !== null ||
    thread.wallet_address?.toLowerCase() === walletAddress.toLowerCase()
  );
}
