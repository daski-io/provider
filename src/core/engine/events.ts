import { EventEmitter } from "node:events";
import type { TransactionRow } from "../db/queries/transactions.js";

export type TaskEvent =
  | { type: "transition"; task: TransactionRow }
  | { type: "artifact"; taskId: string; artifactName: string }
  | { type: "escalation-pending"; task: TransactionRow }
  | { type: "escalation-resolved"; task: TransactionRow };

class TypedEventEmitter extends EventEmitter {
  emitTaskEvent(event: TaskEvent): void {
    this.emit("task", event);
  }
  onTaskEvent(listener: (event: TaskEvent) => void): () => void {
    this.on("task", listener);
    return () => this.off("task", listener);
  }
}

/// Singleton in-process bus used by pushNotifier for task transitions and
/// artifacts. Durable delivery and cross-replica state live outside this bus.
export const taskEvents = new TypedEventEmitter();
taskEvents.setMaxListeners(100); // dashboard + N admin tabs + push worker
