import { appendOperatorChatMessage } from "../../db/queries/operatorChats.js";
import { touchChatThread } from "../../db/queries/chatThreads.js";
import {
  runOperatorLoop,
  type OperatorTurnResult,
} from "./loop.js";

export { runOperatorLoop, type OperatorTurnResult } from "./loop.js";

export async function handleOperatorTurn(args: {
  threadId: string;
  walletAddress: string;
  sessionId: string;
  operatorMessage: string;
  escalationId?: string | null;
}): Promise<OperatorTurnResult> {
  const wallet = args.walletAddress.toLowerCase();
  const operatorTurn = await appendOperatorChatMessage({
    threadId: args.threadId,
    walletAddress: wallet,
    role: "operator",
    content: args.operatorMessage,
  });
  await touchChatThread(args.threadId);
  return runOperatorLoop({
    threadId: args.threadId,
    actor: wallet,
    sessionId: args.sessionId,
    turnId: operatorTurn.id,
    escalationId: args.escalationId ?? null,
    mode: args.escalationId ? "human" : "free_form",
  });
}
