// Engine facade for the A2A task lifecycle. Implementations are split by
// responsibility so adapter I/O, state transitions, and finalization can
// evolve independently while callers use one stable lifecycle surface.
export {
  cancelAdapterTask,
  executeAdapter,
  generateTaskId,
  handleAdapterInput,
} from "./adapterExecution.js";
export {
  claimSupplierMutation,
  TaskTransitionConflict,
  transitionTask,
  transitionTaskIfCurrent,
  type FailureClass,
} from "./taskTransitions.js";
export {
  processAdapterResult,
} from "./taskFinalization.js";
