const validTransitions: Record<string, string[]> = {
  // `failed` is reachable straight from `submitted`: pre-execute rejection
  // and other pre-flight gates terminate a task before it ever starts
  // working (failTransactionWithRefund). Without this edge those paths
  // throw TransitionError, surface as -32603 to the buyer, and strand the
  // row in `submitted` forever.
  submitted: ["working", "failed", "canceled"],
  working: ["completed", "failed", "input-required", "canceled"],
  "input-required": ["working", "canceled"],
};

const terminalStates = new Set(["completed", "failed", "canceled"]);

export function isTerminalState(state: string): boolean {
  return terminalStates.has(state);
}

export function canTransition(from: string, to: string): boolean {
  if (isTerminalState(from)) {
    // Admin-only recovery: failed -> working
    if (from === "failed" && to === "working") return true;
    return false;
  }
  const allowed = validTransitions[from];
  return allowed ? allowed.includes(to) : false;
}

export function validateTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new TransitionError(
      `Invalid state transition: ${from} -> ${to}`
    );
  }
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}
